// apps/backend/src/modules/10-hope/jobs/retention-store.ts — the `hope-retention-scan` cron's Drizzle
// reader/writer over `hope_assessment`, `hope_submission(_item)` and the `hope_retention_review` ledger
// (GAP-181). ORG-scoped, caller-owned `withOrgContext` tx (the caller's per-org fan-out owns the envelope so a
// scan's reads, the outbox publish and the ledger write commit atomically). READ-ONLY over every clinical
// table — the only write is the M10-owned review ledger.
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import { canonicalUuidOrNull } from "../hope-uuid";
import type {
  HopeRetentionBasis,
  HopeRetentionBlocker,
  HopeRetentionFacts,
  HopeRetentionStatus,
} from "./retention";

const A = schema.hopeAssessments;
const ITEM = schema.hopeSubmissionItems;
const SUB = schema.hopeSubmissions;
const REVIEW = schema.hopeRetentionReviews;

/**
 * iQIES item outcomes that mean "CMS did not take this record yet" (an unresolved submission error).
 * A `cancelled` item (R-08: its package was never uploaded) is deliberately absent: CMS never saw it, so it is neither
 * an open error nor a transmission anchor (`transmitted_at` stays null). The cancelled batch's ZIP and per-record XML
 * stay in `hope_submission` / `hope_submission_item` as PHI at rest that no scan, eraser or purge job reaches (spec
 * §4.8 "Cancelled packages"); CW-DS-01 needs a human-approved note.
 */
const OPEN_ERROR_ITEM_STATUSES: ReadonlySet<string> = new Set(["rejected", "blocked", "unmatched"]);

/** One patient's facts plus the siting the ledger row carries. */
export interface HopePatientRetentionFacts extends HopeRetentionFacts {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/**
 * Whether the row's patient is one the M4 legal hold names, decided by the DATABASE on canonical uuids. The hold's patient
 * ids are whatever spelling its creator typed (the uuid format check accepts upper case, and `legalHoldScopeOf` keeps the
 * raw string): compared in JavaScript with `Set.has` against the lower-case `patient_id`, an upper-case id would match
 * nothing and a held patient would be flagged eligible for destruction. A value that is no uuid names no patient, so it is
 * left out instead of reaching a `::uuid` cast that would fail the whole org's scan; the caller is told how many.
 *
 * ponytail: one bound parameter per held patient; a hold list long enough to reach the driver's parameter limit
 * (65 535) needs a `= any($1::uuid[])` array parameter or a chunked read. Legal holds name patients one by one.
 */
export function heldPatientSql(heldPatientIds: ReadonlySet<string>): {
  readonly predicate: SQL<boolean>;
  readonly ignored: number;
} {
  const canonical = new Set<string>();
  let ignored = 0;
  for (const id of heldPatientIds) {
    const parsed = canonicalUuidOrNull(id.trim());
    if (parsed === null) ignored += 1;
    else canonical.add(parsed);
  }
  if (canonical.size === 0) return { predicate: sql<boolean>`false`, ignored };
  return { predicate: sql<boolean>`${inArray(A.patientId, [...canonical])}`, ignored };
}

/** Fold every HOPE assessment + submission outcome for the org into one {@link HopePatientRetentionFacts} per
 * patient. `legalHold` is true for a patient named in `heldPatientIds` (the M4 hold's patients, in any spelling of the
 * uuid); the caller layers the org-wide hold on top. `heldPatientIds` has NO default on purpose: it is a safety input, and
 * a default of "nobody is held" would flag held patients as eligible for destruction when a caller forgot it. */
export async function hopeRetentionFactsForOrg(
  tx: DbClient,
  organizationId: string,
  heldPatientIds: ReadonlySet<string>,
): Promise<HopePatientRetentionFacts[]> {
  const held = heldPatientSql(heldPatientIds);
  if (held.ignored > 0) {
    console.warn(
      `m10: hope-retention-scan: ${held.ignored} legal-hold patient id(s) in organization ${organizationId} are no uuid and name no patient; they were left out of the hold comparison.`,
    );
  }
  const assessments = await tx
    .select({
      id: A.id,
      patientId: A.patientId,
      status: A.status,
      signedAt: A.signedAt,
      updatedAt: A.updatedAt,
      targetDate: A.targetDate,
      correctsAssessmentId: A.correctsAssessmentId,
      supersededById: A.supersededById,
      providerEntityId: A.providerEntityId,
      locationId: A.locationId,
      legalHold: held.predicate,
    })
    .from(A)
    .where(eq(A.organizationId, organizationId));
  const items = await tx
    .select({
      assessmentId: ITEM.hopeAssessmentId,
      itemStatus: ITEM.itemStatus,
      transmittedAt: SUB.transmittedAt,
    })
    .from(ITEM)
    .innerJoin(SUB, eq(SUB.id, ITEM.hopeSubmissionId))
    .where(eq(ITEM.organizationId, organizationId));

  const byAssessment = new Map<string, (typeof items)[number][]>();
  for (const it of items) {
    const list = byAssessment.get(it.assessmentId) ?? [];
    list.push(it);
    byAssessment.set(it.assessmentId, list);
  }

  const byPatient = new Map<string, HopePatientRetentionFacts>();
  for (const a of assessments) {
    const effective = [a.signedAt, a.updatedAt, a.targetDate].reduce<Date>(
      (latest, d) => (d && d.getTime() > latest.getTime() ? d : latest),
      a.targetDate,
    );
    let transmitted: Date | null = null;
    let openError = false;
    for (const it of byAssessment.get(a.id) ?? []) {
      if (it.transmittedAt && (!transmitted || it.transmittedAt > transmitted))
        transmitted = it.transmittedAt;
      // An error on an assessment a later correction SUPERSEDED is resolved — only a live one blocks.
      if (a.supersededById === null && OPEN_ERROR_ITEM_STATUSES.has(it.itemStatus))
        openError = true;
    }
    const pendingCorrection = a.status === "draft" && a.correctsAssessmentId !== null;
    const prior = byPatient.get(a.patientId);
    byPatient.set(a.patientId, {
      patientId: a.patientId,
      providerEntityId: prior?.providerEntityId ?? a.providerEntityId,
      locationId: prior?.locationId ?? a.locationId,
      lastEffectiveAt:
        prior && prior.lastEffectiveAt.getTime() > effective.getTime()
          ? prior.lastEffectiveAt
          : effective,
      lastTransmittedAt:
        prior?.lastTransmittedAt && (!transmitted || prior.lastTransmittedAt > transmitted)
          ? prior.lastTransmittedAt
          : transmitted,
      openIqiesError: (prior?.openIqiesError ?? false) || openError,
      pendingCorrection: (prior?.pendingCorrection ?? false) || pendingCorrection,
      legalHold: (prior?.legalHold ?? false) || a.legalHold === true,
    });
  }
  return [...byPatient.values()];
}

export interface RetentionReviewRow {
  readonly id: string;
  readonly patientId: string;
  readonly status: string;
}

export async function retentionReviewsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<RetentionReviewRow[]> {
  return tx
    .select({ id: REVIEW.id, patientId: REVIEW.patientId, status: REVIEW.status })
    .from(REVIEW)
    .where(eq(REVIEW.organizationId, organizationId));
}

export interface RetentionReviewWrite {
  readonly basis: HopeRetentionBasis;
  readonly anchorAt: Date;
  readonly retentionYears: number;
  readonly eligibleAt: Date;
  readonly status: HopeRetentionStatus;
  readonly blockers: readonly HopeRetentionBlocker[];
  /**
   * The instant the patient was flagged `eligible`. OMITTED on an update, the column is left as it is (an already-flagged
   * patient keeps its original flag instant); `null` clears it (the status left `eligible`); a date sets it.
   */
  readonly flaggedAt?: Date | null;
  readonly evaluatedAt: Date;
}

/**
 * Insert the ledger row for a patient that has none. Returns its id, or `null` when nothing was inserted: another scan
 * inserted this patient's row first (the unique `(organization_id, patient_id)` index; `ON CONFLICT DO NOTHING`, so the
 * org's transaction is not aborted and its other patients' writes survive), or the patient has no HOPE assessment left
 * (a destruction committed after the scan read its facts; a row for a destroyed record would announce it eligible). The
 * caller's read of the existing rows is unlocked, so `null` is a benign lost race and the caller must not publish. The
 * assessment check is a separate statement just before the insert: it narrows the window to one round trip, it does not
 * close it (a destruction still uncommitted at that moment is invisible here).
 */
export async function insertRetentionReview(
  tx: DbClient,
  row: RetentionReviewWrite & {
    readonly organizationId: string;
    readonly providerEntityId: string | null;
    readonly locationId: string | null;
    readonly patientId: string;
  },
): Promise<string | null> {
  const [stillThere] = await tx
    .select({ id: A.id })
    .from(A)
    .where(and(eq(A.organizationId, row.organizationId), eq(A.patientId, row.patientId)))
    .limit(1);
  if (!stillThere) return null;
  const [r] = await tx
    .insert(REVIEW)
    .values({ ...row, blockers: [...row.blockers] })
    .onConflictDoNothing()
    .returning({ id: REVIEW.id });
  return r?.id ?? null;
}

/**
 * Update one ledger row, keyed on the status the decision was judged from (`expectedStatus`, the status the scan read).
 * The scan's read is unlocked, so another scan can move the row, or a destruction can delete it, before this write; an UPDATE
 * keyed on the id alone would then apply a verdict (and let the caller publish `retention_eligible`) judged on a row that is
 * gone or already flagged. The predicate is re-judged against the row this write waited for. Returns whether a row was
 * written; `false` is a benign lost race and the caller must not publish.
 */
export async function updateRetentionReview(
  tx: DbClient,
  id: string,
  expectedStatus: string,
  row: RetentionReviewWrite,
): Promise<boolean> {
  const rows = await tx
    .update(REVIEW)
    .set({ ...row, blockers: [...row.blockers], updatedAt: row.evaluatedAt })
    .where(and(eq(REVIEW.id, id), eq(REVIEW.status, expectedStatus)))
    .returning({ id: REVIEW.id });
  return rows.length === 1;
}
