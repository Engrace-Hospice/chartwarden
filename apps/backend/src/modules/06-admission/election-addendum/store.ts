// apps/backend/src/modules/06-admission/election-addendum/store.ts — the in-transaction primitives behind the
// FY2027 election statement addendum (42 CFR 418.24(c)/(d)). Every function takes the CALLER's org-context tx
// so it composes into activation / discharge / consumer transactions; nothing here opens a transaction.
import { isDeepStrictEqual } from "node:util";
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import type {
  AddendumDiagnosisLine,
  ElectionAddendumExemptionReason,
  ElectionAddendumStatus,
  LocalDate,
  NonCoveredItemSnapshot,
} from "@chartwarden/types";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import { exemptionEventFor, transitionElectionAddendum } from "../state-machines/election-addendum";
import { addendumRequiredForElection, initialAddendumDue, updateAddendumDue } from "./due-dates";
import type { AddendumOutboxPort as AdmissionWriteOutboxPort } from "./outbox-port";

const EA = schema.electionAddenda;
const ADM = schema.admissions;
const EP = schema.electionPeriods;
const CW = schema.complianceWindows;

export type AddendumRow = typeof EA.$inferSelect;
export type AddendumItem = AddendumRow["items"][number];

/** The two compliance-window kinds the addendum owns. */
export const ADDENDUM_WINDOW_KINDS = [
  "election_addendum_initial",
  "election_addendum_update",
] as const;
export type AddendumWindowKind = (typeof ADDENDUM_WINDOW_KINDS)[number];

/** Admission statuses during which the addendum obligation is live (the patient is under hospice care). */
const IN_CARE_STATUSES: ReadonlySet<string> = new Set(["active", "on_hold"]);

/** The admission facts every addendum operation keys on. */
export interface AddendumAdmissionFacts {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly status: string;
  /** Period 1's effective date — the election's effective date (418.24(b)(4)); null until activation. */
  readonly electionEffectiveDate: LocalDate | null;
  readonly electionStatementId: string | null;
  /** True when the addendum is mandatory (effective date >= 2026-10-01). */
  readonly required: boolean;
  /** True while the patient is under hospice care (active / on hold). */
  readonly inCare: boolean;
}

export async function loadAddendumAdmissionFacts(
  tx: DbClient,
  admissionId: string,
): Promise<AddendumAdmissionFacts | null> {
  const [adm] = await tx
    .select({
      id: ADM.id,
      patientId: ADM.patientId,
      providerEntityId: ADM.providerEntityId,
      locationId: ADM.locationId,
      status: ADM.status,
    })
    .from(ADM)
    .where(eq(ADM.id, admissionId))
    .limit(1);
  if (!adm) return null;
  const [period] = await tx
    .select({ effectiveAt: EP.effectiveAt, electionStatementId: EP.electionStatementId })
    .from(EP)
    .where(eq(EP.admissionId, admissionId))
    .orderBy(asc(EP.sequenceNumber))
    .limit(1);
  const effective = period?.effectiveAt ?? null;
  let electionStatementId = period?.electionStatementId ?? null;
  if (!electionStatementId) {
    const ES = schema.electionStatements;
    const [es] = await tx
      .select({ id: ES.id })
      .from(ES)
      .innerJoin(EP, eq(ES.electionPeriodId, EP.id))
      .where(and(eq(EP.admissionId, admissionId), ne(ES.status, "voided")))
      .orderBy(asc(EP.sequenceNumber))
      .limit(1);
    electionStatementId = es?.id ?? null;
  }
  return {
    admissionId: adm.id,
    patientId: adm.patientId,
    providerEntityId: adm.providerEntityId ?? null,
    locationId: adm.locationId ?? null,
    status: adm.status,
    electionEffectiveDate: effective,
    electionStatementId,
    required: effective !== null && addendumRequiredForElection(effective),
    inCare: IN_CARE_STATUSES.has(adm.status),
  };
}

export async function listAddendumVersions(
  tx: DbClient,
  admissionId: string,
): Promise<AddendumRow[]> {
  return tx
    .select()
    .from(EA)
    .where(eq(EA.admissionId, admissionId))
    .orderBy(desc(EA.versionNumber));
}

export async function loadAddendum(tx: DbClient, addendumId: string): Promise<AddendumRow | null> {
  const [row] = await tx.select().from(EA).where(eq(EA.id, addendumId)).limit(1);
  return row ?? null;
}

/** The open (not closed) addendum windows on an admission. */
export async function openAddendumWindows(tx: DbClient, admissionId: string) {
  return tx
    .select({
      id: CW.id,
      windowKind: CW.windowKind,
      status: CW.status,
      mustCompleteBy: CW.mustCompleteBy,
      payload: CW.payload,
    })
    .from(CW)
    .where(
      and(
        eq(CW.admissionId, admissionId),
        inArray(CW.windowKind, [...ADDENDUM_WINDOW_KINDS]),
        ne(CW.status, "closed"),
      ),
    );
}

// ── item merging (pure) ─────────────────────────────────────────────────────────────────────────────

/** Map a source determination onto a stored item line. */
export function itemFromSnapshot(s: NonCoveredItemSnapshot): AddendumItem {
  return {
    category: s.category,
    description: s.description,
    reasonNotCovered: s.reason,
    source: s.source,
    sourceId: s.sourceId,
    sourceReason: s.reason,
  };
}

const sourceKey = (source: string | undefined, id: string | undefined) => `${source}:${id}`;

/**
 * Merge the sources' current determinations into a draft's items: a line a clinician typed (no source) is
 * kept; a source-backed line still reported is kept AS EDITED unless the source's own reason changed since
 * the line was filled (then the new patient-facing reason replaces it); one no longer reported (the
 * relatedness changed) is dropped; a newly reported determination is appended. Pure and order-stable.
 */
export function mergeSourceItems(
  current: readonly AddendumItem[],
  reported: readonly NonCoveredItemSnapshot[],
): AddendumItem[] {
  const byKey = new Map(reported.map((r) => [sourceKey(r.source, r.sourceId), r]));
  const kept = current.flatMap((i): AddendumItem[] => {
    if (!i.source) return [i];
    const r = byKey.get(sourceKey(i.source, i.sourceId));
    if (!r) return [];
    // A line filled before the source reason was tracked keeps its text and starts tracking now.
    if (i.sourceReason === undefined || i.sourceReason === r.reason) {
      return [{ ...i, sourceReason: r.reason }];
    }
    return [{ ...i, reasonNotCovered: r.reason, sourceReason: r.reason }];
  });
  const keptKeys = new Set(
    kept.filter((i) => i.source).map((i) => sourceKey(i.source, i.sourceId)),
  );
  const added = reported
    .filter((r) => !keptKeys.has(sourceKey(r.source, r.sourceId)))
    .map(itemFromSnapshot);
  return [...kept, ...added];
}

/**
 * True when the sources' determinations differ from a version's source-backed lines: a (source, sourceId)
 * added or withdrawn, or a determination whose patient-facing reason changed since the line was filled.
 * Order-insensitive; a clinician's rewording of a line, and clinician-typed lines, are not differences.
 */
export function sourceItemsDiffer(
  version: Pick<AddendumRow, "items">,
  reported: readonly NonCoveredItemSnapshot[],
): boolean {
  const onFile = new Map(
    version.items.filter((i) => i.source).map((i) => [sourceKey(i.source, i.sourceId), i]),
  );
  const now = new Map(reported.map((r) => [sourceKey(r.source, r.sourceId), r]));
  if (onFile.size !== now.size) return true;
  for (const [k, r] of now) {
    const filed = onFile.get(k);
    if (!filed) return true;
    if (filed.sourceReason !== undefined && filed.sourceReason !== r.reason) return true;
  }
  return false;
}

/**
 * A clinician's draft edit replaces `items` wholesale; the tracked source reason is server-owned, so it is
 * carried over from the stored line with the same (source, sourceId) — never taken from the request.
 */
export function carrySourceReasons(
  previous: readonly AddendumItem[],
  edited: readonly AddendumItem[],
): AddendumItem[] {
  const tracked = new Map(
    previous
      .filter((i) => i.source && i.sourceReason !== undefined)
      .map((i) => [sourceKey(i.source, i.sourceId), i.sourceReason as string]),
  );
  return edited.map((i) => {
    const { sourceReason: _ignored, ...rest } = i;
    const reason = i.source ? tracked.get(sourceKey(i.source, i.sourceId)) : undefined;
    return reason !== undefined ? { ...rest, sourceReason: reason } : rest;
  });
}

// ── prefill (resolved by the caller OUTSIDE the transaction) ───────────────────────────────────────────

/** What the sources said, each null when that source was unavailable (keep what is on the row). */
export interface AddendumPrefill {
  readonly patientName: string | null;
  readonly medicalRecordNumber: string | null;
  readonly terminalDiagnosis: readonly AddendumDiagnosisLine[] | null;
  readonly relatedDiagnoses: readonly AddendumDiagnosisLine[] | null;
  readonly items: readonly NonCoveredItemSnapshot[] | null;
}

export const EMPTY_PREFILL: AddendumPrefill = {
  patientName: null,
  medicalRecordNumber: null,
  terminalDiagnosis: null,
  relatedDiagnoses: null,
  items: null,
};

/** Apply a prefill to a DRAFT row's content (pure): fills identity blanks, refreshes diagnoses + items. */
export function applyPrefill(
  row: Pick<
    AddendumRow,
    | "patientName"
    | "medicalRecordNumber"
    | "terminalDiagnosis"
    | "relatedDiagnoses"
    | "items"
    | "noNonCoveredItems"
  >,
  prefill: AddendumPrefill,
) {
  const items = prefill.items ? mergeSourceItems(row.items, prefill.items) : row.items;
  return {
    patientName: row.patientName ?? prefill.patientName,
    medicalRecordNumber: row.medicalRecordNumber ?? prefill.medicalRecordNumber,
    terminalDiagnosis:
      prefill.terminalDiagnosis && prefill.terminalDiagnosis.length > 0
        ? [...prefill.terminalDiagnosis]
        : row.terminalDiagnosis,
    relatedDiagnoses: prefill.relatedDiagnoses
      ? [...prefill.relatedDiagnoses]
      : row.relatedDiagnoses,
    items,
    // A newly reported non-covered item invalidates an earlier "none" determination.
    noNonCoveredItems: items.length > 0 ? false : row.noNonCoveredItems,
  };
}

// ── outbox helpers ───────────────────────────────────────────────────────────────────────────────────

async function emitWindowOpened(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  organizationId: string,
  w: { id: string; admissionId: string; kind: AddendumWindowKind; dueAt: string },
): Promise<void> {
  await outbox.publish(tx, {
    eventName: "m6.compliance.window.opened",
    payload: {
      complianceWindowId: w.id,
      admissionId: w.admissionId,
      windowType: w.kind,
      dueAt: w.dueAt,
      severity: "warning",
    },
    organizationId,
    aggregateKind: "compliance_window",
    aggregateId: w.id,
  });
}

/** Close every open addendum window of `kinds` on the admission; emits `m6.compliance.window.closed`. */
export async function closeAddendumWindows(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  input: {
    organizationId: string;
    admissionId: string;
    kinds: readonly AddendumWindowKind[];
    closedVia: string;
    closedByUserId: string | null;
    at: Date;
  },
): Promise<number> {
  if (input.kinds.length === 0) return 0;
  const closed = await tx
    .update(CW)
    .set({
      status: "closed",
      closedAt: input.at,
      closeReason: input.closedVia,
      closedBy: input.closedByUserId,
      updatedAt: input.at,
      version: sql`${CW.version} + 1`,
    })
    .where(
      and(
        eq(CW.admissionId, input.admissionId),
        inArray(CW.windowKind, [...input.kinds]),
        ne(CW.status, "closed"),
      ),
    )
    .returning({ id: CW.id });
  for (const w of closed) {
    await outbox.publish(tx, {
      eventName: "m6.compliance.window.closed",
      payload: {
        complianceWindowId: w.id,
        closedAt: input.at.toISOString(),
        closedVia: input.closedVia,
      },
      organizationId: input.organizationId,
      aggregateKind: "compliance_window",
      aggregateId: w.id,
    });
  }
  return closed.length;
}

/**
 * Open (or tighten) the addendum window of `kind`: one open window per (admission, kind) — the partial unique
 * `cw_adm_kind_open_idx`. A second plan-of-care change while an update window is open keeps the EARLIER due
 * date (the obligation already started); a later-due change never extends it.
 */
async function openOrTightenWindow(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  input: {
    organizationId: string;
    admissionId: string;
    kind: AddendumWindowKind;
    dueAt: string;
    addendumId: string;
    at: Date;
  },
): Promise<void> {
  const existing = (await openAddendumWindows(tx, input.admissionId)).find(
    (w) => w.windowKind === input.kind,
  );
  if (existing) {
    if (new Date(input.dueAt).getTime() < existing.mustCompleteBy.getTime()) {
      await tx
        .update(CW)
        .set({
          mustCompleteBy: new Date(input.dueAt),
          updatedAt: input.at,
          version: sql`${CW.version} + 1`,
        })
        .where(eq(CW.id, existing.id));
    }
    return;
  }
  const [row] = await tx
    .insert(CW)
    .values({
      organizationId: input.organizationId,
      admissionId: input.admissionId,
      windowKind: input.kind,
      severity: "warning",
      status: "open",
      startsAt: input.at,
      mustCompleteBy: new Date(input.dueAt),
      payload: { electionAddendumId: input.addendumId },
    })
    .onConflictDoNothing()
    .returning({ id: CW.id });
  if (row) {
    await emitWindowOpened(tx, outbox, input.organizationId, {
      id: row.id,
      admissionId: input.admissionId,
      kind: input.kind,
      dueAt: input.dueAt,
    });
  }
}

// ── version creation ─────────────────────────────────────────────────────────────────────────────────

async function hospiceNameFor(
  tx: DbClient,
  organizationId: string,
  providerEntityId: string | null,
): Promise<string | null> {
  if (!providerEntityId) return null;
  return buildFoundationSiteReader().providerEntityLegalName(tx, organizationId, providerEntityId);
}

export interface CreatedVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly dueAt: string | null;
}

/**
 * 418.24(d)(1) — create the INITIAL addendum draft (version 1) and open its 5-day window. Idempotent: a no-op
 * returning null when the admission already has any addendum, or when the election is not in scope
 * (effective before 2026-10-01, or not yet effective).
 */
export async function openInitialAddendumInTx(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  input: {
    organizationId: string;
    admissionId: string;
    prefill?: AddendumPrefill;
    createdByUserId?: string | null;
    now: Date;
  },
): Promise<CreatedVersion | null> {
  const facts = await loadAddendumAdmissionFacts(tx, input.admissionId);
  if (!facts?.electionEffectiveDate || !facts.required) return null;
  const [any] = await tx
    .select({ id: EA.id })
    .from(EA)
    .where(eq(EA.admissionId, input.admissionId))
    .limit(1);
  if (any) return null;
  const tz = await organizationTimezone(tx, input.organizationId);
  const due = initialAddendumDue(facts.electionEffectiveDate, tz);
  const content = applyPrefill(
    {
      patientName: null,
      medicalRecordNumber: null,
      terminalDiagnosis: [],
      relatedDiagnoses: [],
      items: [],
      noNonCoveredItems: false,
    },
    input.prefill ?? EMPTY_PREFILL,
  );
  const [row] = await tx
    .insert(EA)
    .values({
      organizationId: input.organizationId,
      providerEntityId: facts.providerEntityId,
      locationId: facts.locationId,
      patientId: facts.patientId,
      admissionId: input.admissionId,
      electionStatementId: facts.electionStatementId,
      versionNumber: 1,
      trigger: "initial",
      triggerCause: "election",
      triggeredAt: new Date(`${facts.electionEffectiveDate}T00:00:00.000Z`),
      status: "draft",
      hospiceName: await hospiceNameFor(tx, input.organizationId, facts.providerEntityId),
      ...content,
      dueAt: new Date(due.dueAt),
      createdByUserId: input.createdByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: EA.id, versionNumber: EA.versionNumber });
  if (!row) return null; // a racing activation already created it
  await openOrTightenWindow(tx, outbox, {
    organizationId: input.organizationId,
    admissionId: input.admissionId,
    kind: "election_addendum_initial",
    dueAt: due.dueAt,
    addendumId: row.id,
    at: input.now,
  });
  await outbox.publish(tx, {
    eventName: "m6.election_addendum.drafted",
    payload: {
      electionAddendumId: row.id,
      admissionId: input.admissionId,
      versionNumber: 1,
      trigger: "initial",
      dueAt: due.dueAt,
    },
    organizationId: input.organizationId,
    aggregateKind: "election_addendum",
    aggregateId: row.id,
  });
  return { id: row.id, versionNumber: 1, dueAt: due.dueAt };
}

/**
 * 418.24(d)(2) — create the next version after a plan-of-care change, copied from the latest version (so the
 * clinician edits a delta, not a blank form), with the prefill merged in, and open / tighten the 3-day window.
 */
export async function createUpdateVersionInTx(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  input: {
    organizationId: string;
    facts: AddendumAdmissionFacts;
    latest: AddendumRow;
    triggeredAt: Date;
    cause: string;
    prefill: AddendumPrefill;
    createdByUserId: string | null;
    now: Date;
  },
): Promise<CreatedVersion | null> {
  const { latest, facts } = input;
  const tz = await organizationTimezone(tx, input.organizationId);
  const due = facts.required ? updateAddendumDue(input.triggeredAt.toISOString(), tz) : null;
  const content = applyPrefill(latest, input.prefill);
  const [row] = await tx
    .insert(EA)
    .values({
      organizationId: input.organizationId,
      providerEntityId: facts.providerEntityId,
      locationId: facts.locationId,
      patientId: facts.patientId,
      admissionId: facts.admissionId,
      electionStatementId: facts.electionStatementId ?? latest.electionStatementId,
      versionNumber: latest.versionNumber + 1,
      trigger: "poc_change",
      triggerCause: input.cause,
      triggeredAt: input.triggeredAt,
      status: "draft",
      hospiceName:
        (await hospiceNameFor(tx, input.organizationId, facts.providerEntityId)) ??
        latest.hospiceName,
      ...content,
      clinicalExplanation: latest.clinicalExplanation,
      guidelineReferences: latest.guidelineReferences,
      dueAt: due ? new Date(due.dueAt) : null,
      createdByUserId: input.createdByUserId,
    })
    .onConflictDoNothing()
    .returning({ id: EA.id, versionNumber: EA.versionNumber });
  if (!row) return null; // a concurrent change already opened the next draft — it absorbs this one
  if (due) {
    await openOrTightenWindow(tx, outbox, {
      organizationId: input.organizationId,
      admissionId: facts.admissionId,
      kind: "election_addendum_update",
      dueAt: due.dueAt,
      addendumId: row.id,
      at: input.now,
    });
  }
  await outbox.publish(tx, {
    eventName: "m6.election_addendum.drafted",
    payload: {
      electionAddendumId: row.id,
      admissionId: facts.admissionId,
      versionNumber: row.versionNumber,
      trigger: "poc_change",
      dueAt: due?.dueAt ?? null,
    },
    organizationId: input.organizationId,
    aggregateKind: "election_addendum",
    aggregateId: row.id,
  });
  return { id: row.id, versionNumber: row.versionNumber, dueAt: due?.dueAt ?? null };
}

/** JSON round trip: drops `undefined` keys, and `isDeepStrictEqual` ignores key order (JSONB reorders keys). */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

/** True when applying a prefill would change the draft's stored content (pure). */
export function draftContentChanged(
  row: Parameters<typeof applyPrefill>[0],
  next: ReturnType<typeof applyPrefill>,
): boolean {
  return !isDeepStrictEqual(
    plain({
      patientName: row.patientName,
      medicalRecordNumber: row.medicalRecordNumber,
      terminalDiagnosis: row.terminalDiagnosis,
      relatedDiagnoses: row.relatedDiagnoses,
      items: row.items,
      noNonCoveredItems: row.noNonCoveredItems,
    }),
    plain(next),
  );
}

/**
 * Refresh a DRAFT's source-backed content from a prefill (identity blanks, diagnoses, items). A refresh that
 * changes nothing (a redelivered or already-reflected plan-of-care event) writes nothing: bumping `version`
 * would make a concurrent reader's `ifVersion` stale and 409 their next PATCH/furnish for no reason.
 */
export async function refreshDraftInTx(
  tx: DbClient,
  draft: AddendumRow,
  prefill: AddendumPrefill,
  at: Date,
): Promise<void> {
  if (draft.status !== "draft") return;
  const content = applyPrefill(draft, prefill);
  if (!draftContentChanged(draft, content)) return;
  await tx
    .update(EA)
    .set({ ...content, updatedAt: at, version: sql`${EA.version} + 1` })
    .where(and(eq(EA.id, draft.id), eq(EA.status, "draft")));
}

// ── leaving care (418.24(d)(3)/(d)(4)) ──────────────────────────────────────────────────────────────

/** Map an M6 discharge type onto the addendum exemption reason the regulation names. */
export function exemptionReasonForDischarge(
  dischargeType: string,
): ElectionAddendumExemptionReason {
  if (dischargeType === "death") return "death";
  if (dischargeType === "revocation") return "revocation";
  return "discharge";
}

const AUTO_NOTE: Readonly<Record<ElectionAddendumExemptionReason, string>> = {
  death: "The patient died before the addendum could be completed.",
  revocation: "The patient revoked the hospice election before the addendum could be completed.",
  discharge: "The patient was discharged from hospice before the addendum could be completed.",
};

/**
 * Called from the discharge / revocation / transfer-out transaction. Every unfurnished draft becomes
 * `not_required` ((d)(3)) and every furnished-but-unacknowledged version `signature_not_required` ((d)(4)),
 * each with the reason noted ON the addendum; the open addendum windows close. Settled versions are left as
 * they are. Returns how many versions changed.
 */
export async function settleAddendumOnLeavingCareInTx(
  tx: DbClient,
  outbox: AdmissionWriteOutboxPort,
  input: {
    organizationId: string;
    admissionId: string;
    reason: ElectionAddendumExemptionReason;
    at: Date;
  },
): Promise<number> {
  const open = await tx
    .select()
    .from(EA)
    .where(and(eq(EA.admissionId, input.admissionId), inArray(EA.status, ["draft", "furnished"])));
  let changed = 0;
  for (const row of open) {
    const event = exemptionEventFor(row.status, input.reason);
    if (!event) continue;
    const t = transitionElectionAddendum(row.status, event);
    await tx
      .update(EA)
      .set({
        status: t.to,
        signatureNotRequiredReason: input.reason,
        signatureNotRequiredNote: AUTO_NOTE[input.reason],
        signatureNotRequiredAt: input.at,
        updatedAt: input.at,
        version: sql`${EA.version} + 1`,
      })
      .where(and(eq(EA.id, row.id), eq(EA.status, row.status)));
    changed += 1;
    if (t.emits === "m6.election_addendum.not_required") {
      await outbox.publish(tx, {
        eventName: "m6.election_addendum.not_required",
        payload: {
          electionAddendumId: row.id,
          admissionId: input.admissionId,
          versionNumber: row.versionNumber,
          reason: input.reason,
        },
        organizationId: input.organizationId,
        aggregateKind: "election_addendum",
        aggregateId: row.id,
      });
    }
  }
  await closeAddendumWindows(tx, outbox, {
    organizationId: input.organizationId,
    admissionId: input.admissionId,
    kinds: ADDENDUM_WINDOW_KINDS,
    closedVia: `not_required:${input.reason}`,
    closedByUserId: null,
    at: input.at,
  });
  return changed;
}

/** Mark every earlier furnished/settled version that is not yet superseded as superseded by `newId`. */
export async function supersedePriorVersionsInTx(
  tx: DbClient,
  admissionId: string,
  newId: string,
  newVersionNumber: number,
  at: Date,
): Promise<void> {
  await tx
    .update(EA)
    .set({
      supersededById: newId,
      supersededAt: at,
      updatedAt: at,
      version: sql`${EA.version} + 1`,
    })
    .where(
      and(
        eq(EA.admissionId, admissionId),
        isNull(EA.supersededById),
        ne(EA.id, newId),
        sql`${EA.versionNumber} < ${newVersionNumber}`,
        ne(EA.status, "draft"),
      ),
    );
}

/** Statuses that count as "on file" for supersession and history. */
export const FURNISHED_OR_LATER: readonly ElectionAddendumStatus[] = [
  "furnished",
  "signed",
  "refused",
  "signature_not_required",
];
