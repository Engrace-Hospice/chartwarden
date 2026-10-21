// apps/backend/src/modules/29-external-interfaces/inbound/parse-worker.ts — GAP-086. The inbound PARSE / PROCESSING worker:
// it consumes the `hl7_message_inbound` rows the MLLP listener persisted (`parse_status='in_progress'`) and runs each through
// the pure M29 pipeline that already existed but had no caller — projection → patient cascade → proposal / lab attach.
//
//   ADT^A01/A03/A04/A08/A11  projectAdt → matchPatient (§4.6 D6) → planProposal → one `hl7_inbound_proposal` (propose-then-
//                            review, D5; 72h SLA) or an audited routing drop (A03/A11 for an unknown patient).
//   ORU^R01                  projectOru → terminology gate (M38) → resolveLabPatient (OBR-2 placer, else cascade; D7/D8) → SUD
//                            ingress redaction (M39, D15; fail-safe) → planLabAttach → `lab_observation` + values + link, or the
//                            unmatched-review queue entry (GAP-044).
//
// ACK / NACK SEMANTICS (spec §4.11.3 / §2.2). The MLLP ACK was already sent by the listener, AFTER the frame committed:
// `AA` means "received and durably stored", not "clinically applied" — a sender never re-sends because of a downstream parse
// outcome. A message that cannot be applied lands `parse_status='parse_error'` with a typed diagnostic (never retried
// automatically; an operator replays it via `POST …/messages/inbound/:id/replay`, which flips it back to `in_progress`). A
// sender-allowlist violation was NAKed `AR` and stored `rejected` at ingest — this worker never touches those rows.
//
// QUEUE = TABLE. A row is claimed with `FOR UPDATE SKIP LOCKED` inside the tx that writes its results, so two worker replicas
// never process one message, a crash mid-message rolls the whole message back (it is simply claimed again), and a Valkey
// outage cannot lose work. ONE message per transaction: a poison message cannot roll back its neighbours.
//
// TRANSIENT vs PERMANENT. A `ParseRejected` (no PID, unsupported type, malformed) is permanent → `parse_error`. Anything else
// (a seam timeout, a DB error) is transient: the row stays `in_progress` with `parse_error={attempts,lastError}` and is retried
// on later ticks; after `maxAttempts` it becomes `parse_error` so a poison message cannot spin forever.
//
// SUD (42 CFR Part 2). When the SUD gate redacts a lab, the stored wire payload and the stored projection are rewritten with every
// OBX-5 value replaced by the redaction sentinel, so no raw SUD result remains at rest once this worker has run. (The spec's
// strict "redact before the first durable write" cannot be met by the listener alone — it has no matched patient to evaluate
// consent for — so there is a window between ingest and processing in which the sealed payload is unredacted.)
//
// Everything cross-module is an injected PORT (patient reader, order reader, terminology, consent, org settings, outbox).
import { createHash, randomUUID } from "node:crypto";

import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientReader } from "@chartwarden/types";
import { and, asc, eq, notInArray } from "drizzle-orm";

import { isSupportedAdt } from "../proposals/message-type-routing";
import { planProposal } from "../proposals/proposal-builder";
import type { M29WriteOutboxPort } from "../routes/store-drizzle";
import { projectAdt } from "./hl7-adt-projection";
import { projectOru } from "./hl7-oru-projection";
import type { InboundCipher } from "./inbound-crypto";
import { SUD_REDACTED_SENTINEL, planLabAttach } from "./lab-attach-planner";
import {
  type LabOrderPort,
  type LabPatientResolution,
  resolveLabPatient,
} from "./lab-patient-resolver";
import {
  type LabConsentPort,
  type LabSudTerminologyPort,
  decideLabSudRedaction,
} from "./lab-sud-redaction";
import { classifyObservationTerminology } from "./lab-terminology";
import { type MatchOutcome, matchPatient } from "./match-cascade";
import { extractPdfAttachments } from "./obx-pdf";
import { projectCascadeForMessage } from "./outcome-router";

const INBOUND = schema.hl7MessageInbound;
const SYSTEM_USER_ID = "";

/** §2.2 / spec line 216 — the proposal review SLA (`expires_at = proposed_at + 72h`). */
export const PROPOSAL_REVIEW_SLA_MS = 72 * 3_600_000;
export const PARSE_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_PER_ORG = 50;

/** A permanent per-message refusal — `parse_status='parse_error'` with this diagnostic. */
export class ParseRejected extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "ParseRejected";
  }
}

export interface ParseWorkerDeps {
  readonly db: DbClient;
  readonly cipher: InboundCipher;
  /** Thunks: the M5/M11/M38/M39 seams register during `wireModuleSeams()`. */
  readonly patientReader: () => PatientReader;
  readonly orderReader: () => LabOrderPort;
  readonly terminology: () => LabSudTerminologyPort;
  readonly consent: () => LabConsentPort;
  /** `organization.settings.hl7_internal_mrn_authority` (M5) — undefined ⇒ L1 is skipped. */
  readonly internalMrnAuthority: (organizationId: string) => Promise<string | undefined>;
  readonly outbox: M29WriteOutboxPort;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly log?: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  readonly maxAttempts?: number;
  readonly batchPerOrg?: number;
}

export interface SweepResult {
  readonly parsed: number;
  readonly parseErrors: number;
  readonly deferred: number;
}

const ZERO: SweepResult = { parsed: 0, parseErrors: 0, deferred: 0 };
const add = (a: SweepResult, b: SweepResult): SweepResult => ({
  parsed: a.parsed + b.parsed,
  parseErrors: a.parseErrors + b.parseErrors,
  deferred: a.deferred + b.deferred,
});

type InboundRow = typeof INBOUND.$inferSelect;

/** Replace OBX-5 of every OBX segment with the redaction sentinel (field separator read from MSH-1). */
export function redactObxValues(payload: string): string {
  const sep = payload.charAt(3) || "|";
  return payload
    .split(/(\r\n|\r|\n)/)
    .map((line) => {
      if (!line.startsWith("OBX")) return line;
      const fields = line.split(sep);
      if (fields.length > 5) fields[5] = SUD_REDACTED_SENTINEL;
      return fields.join(sep);
    })
    .join("");
}

interface Applied {
  /** The projection to seal into `parsed_segments_cipher` (already masked when SUD-redacted). */
  readonly projection: unknown;
  readonly cascade?: MatchOutcome;
  /** Set when the wire payload must be rewritten (SUD redaction). */
  readonly redactedPayload?: string;
}

async function applyAdt(
  tx: DbClient,
  row: InboundRow,
  payload: string,
  deps: ParseWorkerDeps,
): Promise<Applied> {
  if (!isSupportedAdt(row.messageType)) {
    throw new ParseRejected(
      "unsupported_message_type",
      `${row.messageType} is not a supported ADT trigger`,
    );
  }
  const projected = projectAdt(payload);
  if (projected === null)
    throw new ParseRejected("adt_missing_pid", "ADT message has no PID segment");
  const c = projected.patientCandidate;
  const outcome = await matchPatient(
    {
      organizationId: row.organizationId,
      ...(await withAuthority(deps, row.organizationId)),
      pid: {
        identifiers: c.identifiers,
        lastName: c.lastName,
        firstName: c.firstName,
        dateOfBirth: c.dateOfBirth,
        administrativeSex: c.administrativeSex,
        ...(c.ssnLast4 ? { ssnLast4: c.ssnLast4 } : {}),
      },
    },
    { patientReader: deps.patientReader() },
  );
  const now = (deps.now ?? (() => new Date()))();
  const context = {
    messageId: row.id,
    feedId: row.feedId,
    organizationId: row.organizationId,
    messageControlId: row.messageControlId,
    messageType: row.messageType,
  };
  const plan = planProposal({
    outcome,
    context,
    proposedPatientCandidate: projected,
    proposalId: (deps.newId ?? randomUUID)(),
    proposedAt: now,
    expiresAt: new Date(now.getTime() + PROPOSAL_REVIEW_SLA_MS),
  });
  if (plan.kind === "create") {
    await tx.insert(schema.hl7InboundProposal).values(plan.proposal);
    await deps.outbox.publish(tx, {
      eventName: plan.event.name,
      payload: { ...plan.event.payload },
      organizationId: row.organizationId,
      aggregateKind: "hl7_inbound_proposal",
      aggregateId: plan.proposal.id as string,
    });
  } else if (plan.kind === "drop") {
    await deps.outbox.publish(tx, {
      eventName: plan.event.name,
      payload: { ...plan.event.payload },
      organizationId: row.organizationId,
      aggregateKind: "hl7_message_inbound",
      aggregateId: row.id,
    });
  } else {
    throw new ParseRejected("unsupported_message_type", plan.reason);
  }
  return { projection: projected, cascade: outcome };
}

async function withAuthority(
  deps: ParseWorkerDeps,
  organizationId: string,
): Promise<{ internalMrnAuthority?: string }> {
  const authority = await deps.internalMrnAuthority(organizationId);
  return authority ? { internalMrnAuthority: authority } : {};
}

async function applyOru(
  tx: DbClient,
  row: InboundRow,
  payload: string,
  deps: ParseWorkerDeps,
): Promise<Applied> {
  const projected = projectOru(payload);
  if (projected === null) {
    throw new ParseRejected("oru_missing_pid_or_obx", "ORU message has no PID or no OBX segment");
  }
  const now = (deps.now ?? (() => new Date()))();
  const patients = deps.patientReader();
  const asOfDate = (projected.obr.observationDate ?? now.toISOString()).slice(0, 10);

  const terminologyValidation = await classifyObservationTerminology(
    projected.obxList,
    asOfDate,
    deps.terminology(),
  );
  let resolution: LabPatientResolution = await resolveLabPatient(
    {
      organizationId: row.organizationId,
      placerOrderNumber: projected.obr.placerOrderNumber,
      patientCandidate: projected.patientCandidate,
      ...(await withAuthority(deps, row.organizationId)),
    },
    { patientReader: patients, orderReader: deps.orderReader() },
  );

  // ARCH-011 — a matched lab needs the patient's agency; a patient without one cannot be attached, so the result goes to
  // the review queue (naming the patient as the candidate) instead of inventing a provider entity.
  let providerEntityId: string | null = null;
  let locationId: string | null = null;
  if (resolution.kind === "matched") {
    const patient = await patients.findById({
      organizationId: row.organizationId,
      id: resolution.patientId,
    });
    if (patient?.providerEntityId) {
      providerEntityId = patient.providerEntityId;
      locationId = patient.locationId ?? null;
    } else {
      deps.log?.("warn", "hl7.lab.patient_agency_missing", { messageId: row.id });
      resolution = {
        kind: "unmatched",
        matchMethod: "unmatched",
        candidatePatientId: resolution.patientId,
        candidateMatchLevel: "NO_MATCH",
        matchConfidence: null,
      };
    }
  }

  const sud = await decideLabSudRedaction(
    {
      organizationId: row.organizationId,
      patientId: resolution.kind === "matched" ? resolution.patientId : null,
      loincCodes: projected.obxList.map((o) => o.loincCode),
      asOf: asOfDate,
    },
    { consent: deps.consent(), terminology: deps.terminology() },
  );

  const pdfAttachments = extractPdfAttachments(projected.obxList);
  const plan = planLabAttach({
    organizationId: row.organizationId,
    sourceMessageId: row.id,
    providerEntityId: providerEntityId ?? "",
    locationId,
    obr: projected.obr,
    obxList: projected.obxList,
    resolution,
    terminologyValidation,
    sudRedacted: sud.redact,
    pdfAttachments,
    observationId: (deps.newId ?? randomUUID)(),
    linkId: (deps.newId ?? randomUUID)(),
    receivedAt: row.receivedAt,
  });

  if (plan.kind === "attach") {
    await tx.insert(schema.labObservation).values(plan.observation);
    if (plan.values.length > 0)
      await tx.insert(schema.labObservationValue).values([...plan.values]);
    await tx.insert(schema.labObservationInboundLink).values(plan.link);
    for (const event of plan.events) {
      // The M22 PDF handshake has no consumer yet (`m29.document.upload_requested` is not in the boot catalog) and its
      // payload carries the whole PDF — it is logged, not published.
      if (event.name === "m29.document.upload_requested") {
        deps.log?.("warn", "hl7.lab.pdf_attachment_deferred", { messageId: row.id });
        continue;
      }
      await deps.outbox.publish(tx, {
        eventName: event.name,
        payload: { ...event.payload },
        organizationId: row.organizationId,
        aggregateKind: "lab_observation",
        aggregateId: plan.observation.id as string,
      });
    }
  } else {
    if (plan.values.length > 0)
      await tx.insert(schema.labObservationValue).values([...plan.values]);
    await tx.insert(schema.labObservationInboundLink).values(plan.link);
    await deps.outbox.publish(tx, {
      eventName: plan.event.name,
      payload: { ...plan.event.payload },
      organizationId: row.organizationId,
      aggregateKind: "lab_observation",
      aggregateId: plan.event.payload.observationId,
    });
  }

  if (sud.redact) {
    return {
      projection: {
        ...projected,
        obxList: projected.obxList.map((o) => ({ ...o, value: SUD_REDACTED_SENTINEL })),
      },
      redactedPayload: redactObxValues(payload),
    };
  }
  return { projection: projected };
}

/** Process ONE claimed row inside its tx; returns the row's final column patch. Throws `ParseRejected` for permanent refusals. */
async function processRow(
  tx: DbClient,
  row: InboundRow,
  deps: ParseWorkerDeps,
): Promise<Partial<typeof INBOUND.$inferInsert>> {
  const payload = await deps.cipher.decrypt(
    row.organizationId,
    "hl7_message_inbound.payload",
    row.payloadCipher,
  );
  let applied: Applied;
  if (row.messageType.startsWith("ADT^")) applied = await applyAdt(tx, row, payload, deps);
  else if (row.messageType.startsWith("ORU^")) applied = await applyOru(tx, row, payload, deps);
  else {
    throw new ParseRejected(
      "unsupported_message_type",
      `${row.messageType} is not an inbound type this feed handles`,
    );
  }
  const projectionJson = JSON.stringify(applied.projection);
  const patch: Partial<typeof INBOUND.$inferInsert> = {
    parseStatus: "parsed",
    parseError: null,
    parsedSegmentsCipher: await deps.cipher.encrypt(
      row.organizationId,
      "hl7_message_inbound.parsed_segments",
      projectionJson,
    ),
    parsedSegmentsSha256: createHash("sha256").update(projectionJson).digest("hex"),
    ...(applied.cascade ? projectCascadeForMessage(applied.cascade) : {}),
  };
  if (applied.redactedPayload !== undefined) {
    patch.payloadCipher = await deps.cipher.encrypt(
      row.organizationId,
      "hl7_message_inbound.payload",
      applied.redactedPayload,
    );
  }
  return patch;
}

const attemptsOf = (row: InboundRow): number => {
  const e = row.parseError as { attempts?: unknown } | null;
  return typeof e?.attempts === "number" ? e.attempts : 0;
};

/** Claim + process one `in_progress` message of an org. Resolves null when none is claimable. */
async function processNext(
  organizationId: string,
  deps: ParseWorkerDeps,
  skip: ReadonlySet<string>,
): Promise<{ id: string; outcome: keyof SweepResult } | null> {
  const maxAttempts = deps.maxAttempts ?? PARSE_MAX_ATTEMPTS;
  let claimedRow: InboundRow | null = null;
  try {
    return await withOrgContext(
      deps.db,
      { organizationId, userId: SYSTEM_USER_ID },
      async (scoped) => {
        const tx = scoped as DbClient;
        const [row] = await tx
          .select()
          .from(INBOUND)
          .where(
            and(
              eq(INBOUND.organizationId, organizationId),
              eq(INBOUND.parseStatus, "in_progress"),
              ...(skip.size > 0 ? [notInArray(INBOUND.id, [...skip])] : []),
            ),
          )
          .orderBy(asc(INBOUND.receivedAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return null;
        claimedRow = row;
        try {
          const patch = await processRow(tx, row, deps);
          const updated = await tx
            .update(INBOUND)
            .set(patch)
            .where(and(eq(INBOUND.id, row.id), eq(INBOUND.organizationId, organizationId)))
            .returning({ id: INBOUND.id });
          if (updated.length === 0) throw new Error("inbound message row vanished mid-processing");
          return { id: row.id, outcome: "parsed" as const };
        } catch (err) {
          if (!(err instanceof ParseRejected)) throw err;
          // Permanent refusal: no writes happened before the throw; record the diagnostic on the row.
          await tx
            .update(INBOUND)
            .set({ parseStatus: "parse_error", parseError: { code: err.code, reason: err.reason } })
            .where(and(eq(INBOUND.id, row.id), eq(INBOUND.organizationId, organizationId)));
          return { id: row.id, outcome: "parseErrors" as const };
        }
      },
    );
  } catch (err) {
    const row = claimedRow as InboundRow | null;
    if (row === null) throw err;
    // Transient: the message tx rolled back. Record the attempt in its own tx.
    const attempts = attemptsOf(row) + 1;
    const lastError = err instanceof Error ? err.name : "unknown";
    deps.log?.("warn", "hl7.parse.transient_failure", { messageId: row.id, attempts, lastError });
    const exhausted = attempts >= maxAttempts;
    await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
      await (scoped as DbClient)
        .update(INBOUND)
        .set({
          parseStatus: exhausted ? "parse_error" : "in_progress",
          parseError: exhausted
            ? { code: "attempts_exhausted", reason: lastError, attempts }
            : { code: "transient", reason: lastError, attempts },
        })
        .where(and(eq(INBOUND.id, row.id), eq(INBOUND.organizationId, organizationId)));
    });
    return { id: row.id, outcome: exhausted ? "parseErrors" : "deferred" };
  }
}

/** Drain up to `batchPerOrg` messages of one org (one message per tx). */
export async function runParseSweepForOrg(
  organizationId: string,
  deps: ParseWorkerDeps,
): Promise<SweepResult> {
  const seen = new Set<string>();
  let total = ZERO;
  for (let i = 0; i < (deps.batchPerOrg ?? DEFAULT_BATCH_PER_ORG); i += 1) {
    const next = await processNext(organizationId, deps, seen);
    if (next === null) break;
    seen.add(next.id);
    total = add(total, { ...ZERO, [next.outcome]: 1 });
  }
  return total;
}

export interface ParseSweepDeps extends ParseWorkerDeps {
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
}

/** One tick across every active org. A failing org never blocks the others. */
export async function runParseSweep(deps: ParseSweepDeps): Promise<SweepResult> {
  let total = ZERO;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      total = add(total, await runParseSweepForOrg(organizationId, deps));
    } catch (err) {
      deps.log?.("warn", "hl7.parse.org_sweep_failed", {
        organizationId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  if (total.parsed + total.parseErrors + total.deferred > 0) {
    deps.log?.("info", "hl7.parse.sweep", { ...total });
  }
  return total;
}

export const PARSE_WORKER_DEFAULT_INTERVAL_MS = 2_000;

/** The in-process poller (single-flight; `unref`'d). Replicas coordinate through `SKIP LOCKED`. */
export function startParseWorker(deps: ParseSweepDeps & { readonly intervalMs?: number }): {
  close(): Promise<void>;
} {
  let running: Promise<unknown> | null = null;
  const tick = (): void => {
    if (running) return;
    running = runParseSweep(deps)
      .catch((err) =>
        deps.log?.("warn", "hl7.parse.sweep_failed", {
          errorName: err instanceof Error ? err.name : "unknown",
        }),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, deps.intervalMs ?? PARSE_WORKER_DEFAULT_INTERVAL_MS);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      if (running) await running;
    },
  };
}
