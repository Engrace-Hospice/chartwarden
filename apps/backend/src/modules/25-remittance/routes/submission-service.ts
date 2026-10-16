// apps/backend/src/modules/25-remittance/routes/submission-service.ts - M25 milestone 6a: the submission attempt.
//
// `recordFilingAttempt` is the ONE helper each existing submit (ADR, reopening, QIC escalation, appeal) calls inside
// its own transaction, so the attempt and the case move together. ADR, reopening and escalation already carry channel,
// reference and time, so their attempt is born `acknowledged` (source `entered`); an appeal submit carries none, so its
// attempt is born `needs_manual` (the case still moves to `submitted` exactly as before) and the user records the
// receipt afterwards through `recordReceipt`. The case-table filing columns stay authoritative; the attempt mirrors them.
//
// Nothing is transmitted here or anywhere in 6a: the only live adapter is the guided manual one, and the esMD / fax
// shells are unbound (registry.ts). A recorded receipt is frozen by trigger; a correction appends to
// `receipt_amendments`. No outbox events (nothing consumes them); the write-audit trigger and the rows are the trail.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  type ReceiptRefusal,
  type SubmissionChannel,
  type SubmissionPurpose,
  type SubmissionStatus,
  canTransitionSubmission,
  checkReceipt,
  isLiveSubmissionStatus,
  nextAttemptNumber,
  submissionIdempotencyKey,
} from "../domain";
import {
  type AdapterRegistry,
  DEFAULT_ADAPTER_REGISTRY,
  adapterStatuses,
  planAttempt,
} from "../submission/registry";
import type { M25ReadActor, M25WriteActor } from "./actor";
import {
  type AppealSourcePorts,
  UNBOUND_APPEAL_SOURCES,
  describeEnclosures,
} from "./appeal-packet-sources";
import { VersionConflictError } from "./concurrency";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type AttemptRow = typeof schema.submissionAttempt.$inferSelect;
const SA = schema.submissionAttempt;

export type SubmissionSubjectKind = "adr" | "appeal" | "reopening";

export interface RecordFilingAttemptInput {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly purpose: SubmissionPurpose;
  readonly subjectId: string;
  /** What the case recorded; all null for an appeal submit (no channel is captured there). */
  readonly channel: SubmissionChannel | null;
  readonly confirmationRef: string | null;
  readonly receiptAt: Date | null;
  readonly receiptDocumentId?: string | null;
  readonly packetManifest?: unknown;
  readonly actorMembershipId: string;
  readonly registry?: AdapterRegistry;
}

const subjectColumn = {
  adr_response: SA.adrCaseId,
  appeal_request: SA.appealCaseId,
  qic_escalation_request: SA.appealCaseId,
  reopening_request: SA.reopeningCaseId,
} as const;

const subjectValues = (purpose: SubmissionPurpose, subjectId: string) =>
  purpose === "adr_response"
    ? { adrCaseId: subjectId }
    : purpose === "reopening_request"
      ? { reopeningCaseId: subjectId }
      : { appealCaseId: subjectId };

/**
 * Insert the attempt for a filing, inside the caller's transaction. Refuses (409) when a live attempt already exists for
 * the subject and purpose, so a duplicate filing is never recorded twice.
 */
export async function recordFilingAttempt(tx: Tx, input: RecordFilingAttemptInput): Promise<void> {
  const column = subjectColumn[input.purpose];
  const history = await tx
    .select({ attemptNo: SA.attemptNo, status: SA.status })
    .from(SA)
    .where(and(eq(SA.purpose, input.purpose), eq(column, input.subjectId)));
  if (history.some((h) => isLiveSubmissionStatus(h.status as SubmissionStatus))) {
    throw new WardenXError(
      "SUBMISSION_ATTEMPT_LIVE",
      "this filing already has a submission attempt in progress",
      409,
    );
  }
  const attemptNo = nextAttemptNumber(history.map((h) => h.attemptNo));
  const proven = input.confirmationRef !== null && input.receiptAt !== null;
  const plan = proven
    ? null
    : planAttempt(input.registry ?? DEFAULT_ADAPTER_REGISTRY, input.organizationId, input.channel);
  await tx.insert(SA).values({
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    ...subjectValues(input.purpose, input.subjectId),
    purpose: input.purpose,
    attemptNo,
    idempotencyKey: submissionIdempotencyKey(input.purpose, input.subjectId, attemptNo),
    channel: input.channel,
    adapter: "manual",
    status: proven ? "acknowledged" : (plan?.status ?? "needs_manual"),
    needsManualReason: plan?.reason ?? null,
    preparedByMembershipId: input.actorMembershipId,
    confirmationRef: proven ? input.confirmationRef : null,
    receiptAt: proven ? input.receiptAt : null,
    receiptSource: proven ? "entered" : null,
    receiptDocumentId: proven ? (input.receiptDocumentId ?? null) : null,
    packetManifest: input.packetManifest ?? null,
  });
}

export interface ReceiptInput {
  readonly attemptId: string;
  readonly confirmationRef: string;
  readonly receiptAt: string;
  readonly receiptDocumentId?: string;
}

export interface SubmissionAttemptView {
  readonly id: string;
  readonly purpose: string;
  readonly attemptNo: number;
  readonly channel: string | null;
  readonly adapter: string;
  readonly status: string;
  readonly needsManualReason: string | null;
  readonly confirmationRef: string | null;
  readonly receiptAt: string | null;
  readonly receiptDocumentId: string | null;
  readonly receiptSource: string | null;
  readonly amendments: readonly {
    readonly recordedAt: string;
    readonly confirmationRef: string;
    readonly receiptAt: string;
    readonly receiptDocumentId: string | null;
  }[];
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
  readonly proofMissing: boolean;
}

export interface SubmissionView {
  readonly subjectKind: SubmissionSubjectKind;
  readonly subjectId: string;
  readonly attempts: readonly SubmissionAttemptView[];
  /** True when any live attempt is still waiting for the receipt. */
  readonly proofMissing: boolean;
  /** True for a case filed before milestone 6: it has no attempt record. */
  readonly noAttemptRecord: boolean;
  readonly adapters: readonly { kind: string; mode: string; bound: boolean; reason: string }[];
  readonly checklist: readonly { key: string; text: string }[];
}

export interface SubmissionService {
  getSubmission(
    actor: M25ReadActor,
    kind: SubmissionSubjectKind,
    id: string,
  ): Promise<SubmissionView>;
  recordReceipt(
    actor: M25WriteActor,
    kind: SubmissionSubjectKind,
    id: string,
    input: ReceiptInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number; amended: boolean }>;
  cancelAttempt(
    actor: M25WriteActor,
    kind: SubmissionSubjectKind,
    id: string,
    attemptId: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface SubmissionServiceDeps {
  /** Where a retained receipt document is validated (M22 / M23 seams). Default: refuse a receipt document. */
  readonly sources?: AppealSourcePorts;
  readonly registry?: AdapterRegistry;
  readonly now?: () => Date;
}

const RECEIPT_MESSAGES: Readonly<Record<ReceiptRefusal, string>> = {
  PROOF_REQUIRED: "record the confirmation or tracking reference exactly as the channel shows it",
  REFERENCE_TOO_LONG: "the confirmation reference is too long",
  MBI_NOT_ALLOWED:
    "that looks like a Medicare number. Do not enter the Medicare number; enter the channel's confirmation reference",
  RECEIPT_TIME_INVALID: "the receipt time is not a real date and time",
  RECEIPT_IN_FUTURE: "the receipt time cannot be in the future",
};

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dayOf = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

interface Subject {
  readonly providerEntityId: string;
  readonly claimId: string;
  readonly macName: string | null;
  readonly deadline: string | null;
  readonly defaultPurpose: SubmissionPurpose;
}

async function loadSubject(
  tx: Tx,
  actor: M25ReadActor,
  kind: SubmissionSubjectKind,
  id: string,
): Promise<Subject> {
  if (kind === "adr") {
    const T = schema.adrCase;
    const scope = providerEntityScopeCondition(T.providerEntityId, actor.providerEntityScope);
    const [r] = await tx
      .select()
      .from(T)
      .where(scope ? and(eq(T.id, id), scope) : eq(T.id, id))
      .limit(1);
    if (!r) throw new NotFoundError("ADR case");
    return {
      providerEntityId: r.providerEntityId,
      claimId: r.claimId,
      macName: r.macName,
      deadline: dayOf(r.responseDueAt),
      defaultPurpose: "adr_response",
    };
  }
  if (kind === "reopening") {
    const T = schema.reopeningCase;
    const scope = providerEntityScopeCondition(T.providerEntityId, actor.providerEntityScope);
    const [r] = await tx
      .select()
      .from(T)
      .where(scope ? and(eq(T.id, id), scope) : eq(T.id, id))
      .limit(1);
    if (!r) throw new NotFoundError("reopening case");
    return {
      providerEntityId: r.providerEntityId,
      claimId: r.claimId,
      macName: r.macName,
      deadline: dayOf(r.dueAt),
      defaultPurpose: "reopening_request",
    };
  }
  const T = schema.appealCase;
  const scope = providerEntityScopeCondition(T.providerEntityId, actor.providerEntityScope);
  const [r] = await tx
    .select()
    .from(T)
    .where(scope ? and(eq(T.id, id), scope) : eq(T.id, id))
    .limit(1);
  if (!r) throw new NotFoundError("appeal case");
  return {
    providerEntityId: r.providerEntityId,
    claimId: r.claimId,
    macName: null,
    deadline: dayOf(r.tierDeadlineAt),
    defaultPurpose: "appeal_request",
  };
}

const subjectFilter = (kind: SubmissionSubjectKind, id: string) =>
  kind === "adr"
    ? eq(SA.adrCaseId, id)
    : kind === "reopening"
      ? eq(SA.reopeningCaseId, id)
      : eq(SA.appealCaseId, id);

function amendmentsOf(value: unknown): SubmissionAttemptView["amendments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) =>
    e && typeof e === "object"
      ? [
          {
            recordedAt: String((e as { recordedAt?: unknown }).recordedAt ?? ""),
            confirmationRef: String((e as { confirmationRef?: unknown }).confirmationRef ?? ""),
            receiptAt: String((e as { receiptAt?: unknown }).receiptAt ?? ""),
            receiptDocumentId:
              ((e as { receiptDocumentId?: unknown }).receiptDocumentId as string | null) ?? null,
          },
        ]
      : [],
  );
}

export function buildDrizzleSubmissionService(
  db: DbClient,
  deps: SubmissionServiceDeps = {},
): SubmissionService {
  const sources = deps.sources ?? UNBOUND_APPEAL_SOURCES;
  const registry = deps.registry ?? DEFAULT_ADAPTER_REGISTRY;
  const nowOf = deps.now ?? (() => new Date());

  const view = (a: AttemptRow): SubmissionAttemptView => ({
    id: a.id,
    purpose: a.purpose,
    attemptNo: a.attemptNo,
    channel: a.channel,
    adapter: a.adapter,
    status: a.status,
    needsManualReason: a.needsManualReason,
    confirmationRef: a.confirmationRef,
    receiptAt: iso(a.receiptAt),
    receiptDocumentId: a.receiptDocumentId,
    receiptSource: a.receiptSource,
    amendments: amendmentsOf(a.receiptAmendments),
    approvedAt: iso(a.approvedAt),
    createdAt: a.createdAt.toISOString(),
    version: a.version,
    // Visible the moment the attempt waits for its receipt; the nightly alert adds a threshold on top.
    proofMissing: a.status === "needs_manual",
  });

  async function loadAttempt(
    tx: Tx,
    kind: SubmissionSubjectKind,
    subjectId: string,
    attemptId: string,
  ): Promise<AttemptRow> {
    const [row] = await tx
      .select()
      .from(SA)
      .where(and(eq(SA.id, attemptId), subjectFilter(kind, subjectId)))
      .limit(1);
    if (!row) throw new NotFoundError("submission attempt");
    return row;
  }

  async function validateReceiptDocument(
    organizationId: string,
    claimId: string,
    documentId: string,
  ): Promise<void> {
    const claim = await sources.claims().claimCopyForAppeal(organizationId, claimId);
    if (!claim) {
      throw new WardenXError(
        "SUBMISSION_CLAIM_UNAVAILABLE",
        "the claim for this filing cannot be read, so the receipt document cannot be validated",
        422,
      );
    }
    await describeEnclosures(
      sources.documents(),
      organizationId,
      claim.patientId,
      [documentId],
      undefined,
      "submission receipt",
    );
  }

  return {
    async getSubmission(actor, kind, id) {
      return withOrgContext(db, actor, async (tx) => {
        const subject = await loadSubject(tx, actor, kind, id);
        const rows = await tx
          .select()
          .from(SA)
          .where(subjectFilter(kind, id))
          .orderBy(desc(SA.createdAt), asc(SA.attemptNo));
        const attempts = rows.map(view);
        const live = rows.find((r) => isLiveSubmissionStatus(r.status as SubmissionStatus));
        const purpose = (live?.purpose ??
          rows[0]?.purpose ??
          subject.defaultPurpose) as SubmissionPurpose;
        return {
          subjectKind: kind,
          subjectId: id,
          attempts,
          proofMissing: attempts.some((a) => a.proofMissing),
          noAttemptRecord: rows.length === 0,
          adapters: adapterStatuses(registry, actor.organizationId),
          checklist: registry.manual.guide({
            purpose,
            macName: subject.macName,
            deadline: subject.deadline,
          }),
        };
      });
    },

    async recordReceipt(actor, kind, id, input, ifMatch) {
      const now = nowOf();
      const receiptAt = new Date(input.receiptAt);
      const refusal = checkReceipt({ confirmationRef: input.confirmationRef, receiptAt, now });
      if (refusal) throw new WardenXError(refusal, RECEIPT_MESSAGES[refusal], 422);
      return withOrgContext(db, actor, async (tx) => {
        const subject = await loadSubject(tx, actor, kind, id);
        const cur = await loadAttempt(tx, kind, id, input.attemptId);
        if (input.receiptDocumentId) {
          await validateReceiptDocument(
            actor.organizationId,
            subject.claimId,
            input.receiptDocumentId,
          );
        }
        const status = cur.status as SubmissionStatus;
        if (status === "acknowledged") {
          // The receipt is frozen; a correction is appended, never rewritten (the trigger refuses anything else).
          const amendment = {
            recordedAt: now.toISOString(),
            byMembershipId: actor.membershipId,
            confirmationRef: input.confirmationRef.trim(),
            receiptAt: receiptAt.toISOString(),
            receiptDocumentId: input.receiptDocumentId ?? null,
          };
          const updated = await tx
            .update(SA)
            .set({
              receiptAmendments: sql`${SA.receiptAmendments} || ${JSON.stringify([amendment])}::jsonb`,
              version: cur.version + 1,
              updatedAt: now,
            })
            .where(and(eq(SA.id, cur.id), eq(SA.version, ifMatch)))
            .returning({ id: SA.id, version: SA.version });
          if (!updated[0]) throw new VersionConflictError(cur.version);
          return { ...updated[0], amended: true };
        }
        if (!canTransitionSubmission(status, "acknowledged")) {
          throw new WardenXError(
            "SUBMISSION_NOT_AWAITING_RECEIPT",
            `a receipt cannot be recorded on a ${status} attempt`,
            409,
          );
        }
        const updated = await tx
          .update(SA)
          .set({
            status: "acknowledged",
            confirmationRef: input.confirmationRef.trim(),
            receiptAt,
            receiptSource: "entered",
            receiptDocumentId: input.receiptDocumentId ?? null,
            needsManualReason: null,
            version: cur.version + 1,
            updatedAt: now,
          })
          .where(and(eq(SA.id, cur.id), eq(SA.version, ifMatch)))
          .returning({ id: SA.id, version: SA.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return { ...updated[0], amended: false };
      });
    },

    async cancelAttempt(actor, kind, id, attemptId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        await loadSubject(tx, actor, kind, id);
        const cur = await loadAttempt(tx, kind, id, attemptId);
        if (!canTransitionSubmission(cur.status as SubmissionStatus, "cancelled")) {
          throw new WardenXError(
            "SUBMISSION_NOT_CANCELLABLE",
            `a ${cur.status} attempt cannot be cancelled`,
            409,
          );
        }
        const updated = await tx
          .update(SA)
          .set({ status: "cancelled", version: cur.version + 1, updatedAt: nowOf() })
          .where(and(eq(SA.id, cur.id), eq(SA.version, ifMatch)))
          .returning({ id: SA.id, version: SA.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return updated[0];
      });
    },
  };
}
