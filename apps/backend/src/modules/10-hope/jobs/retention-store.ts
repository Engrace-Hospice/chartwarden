// apps/backend/src/modules/10-hope/jobs/retention-store.ts — the `hope-retention-scan` cron's Drizzle
// reader/writer over `hope_assessment`, `hope_submission(_item)` and the `hope_retention_review` ledger
// (GAP-181). ORG-scoped, caller-owned `withOrgContext` tx (the caller's per-org fan-out owns the envelope so a
// scan's reads, the outbox publish and the ledger write commit atomically). READ-ONLY over every clinical
// table — the only write is the M10-owned review ledger.
import { type DbClient, schema } from "@wardenx/db";
import { eq } from "drizzle-orm";
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

/** iQIES item outcomes that mean "CMS did not take this record yet" (an unresolved submission error). */
const OPEN_ERROR_ITEM_STATUSES: ReadonlySet<string> = new Set(["rejected", "blocked", "unmatched"]);

/** One patient's facts plus the siting the ledger row carries. */
export interface HopePatientRetentionFacts extends HopeRetentionFacts {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** Fold every HOPE assessment + submission outcome for the org into one {@link HopePatientRetentionFacts} per
 * patient. `legalHold` is left false here — the caller layers the M4 hold scope on. */
export async function hopeRetentionFactsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<HopePatientRetentionFacts[]> {
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
      legalHold: false,
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
  readonly flaggedAt: Date | null;
  readonly evaluatedAt: Date;
}

export async function insertRetentionReview(
  tx: DbClient,
  row: RetentionReviewWrite & {
    readonly organizationId: string;
    readonly providerEntityId: string | null;
    readonly locationId: string | null;
    readonly patientId: string;
  },
): Promise<string> {
  const [r] = await tx
    .insert(REVIEW)
    .values({ ...row, blockers: [...row.blockers] })
    .returning({ id: REVIEW.id });
  if (!r) throw new Error("hope_retention_review insert returned no row");
  return r.id;
}

export async function updateRetentionReview(
  tx: DbClient,
  id: string,
  row: RetentionReviewWrite,
): Promise<void> {
  await tx
    .update(REVIEW)
    .set({ ...row, blockers: [...row.blockers], updatedAt: row.evaluatedAt })
    .where(eq(REVIEW.id, id));
}
