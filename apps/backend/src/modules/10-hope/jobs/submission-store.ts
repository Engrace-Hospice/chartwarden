// apps/backend/src/modules/10-hope/jobs/submission-store.ts — the Drizzle read/write half of §4.10
// stages 2 and 3 (`iqies-submit-worker`, `iqies-reconcile-worker`), F-072 / #177.
//
// WHAT THIS COMPLETES. F-058 (#150) built stage 1: `hope_submission_item` gained a writer and batches
// stopped being empty. Stages 2 and 3 were still unbuilt, and with them five pure planners that shipped
// unit-tested with no production callers — `decideSubmitReadiness`, `buildSubmissionEnvelope`,
// `planTransmitResult`, `planReconcile`, `planCorrectionRfa` — plus `hasBlockingError`, whose whole
// purpose is to gate a transmit that had no transmit-time to run in. Every batch stopped at `queued`,
// so `m10.hope.submission_transmitted` / `_accepted` / `_rejected` were emitted by nothing and M30's
// acceptance-rate measure could never have a denominator.
//
// WHAT IS STILL NOT HERE, and is not this file's to supply: the iQIES WIRE PROTOCOL. The CMS endpoint,
// its authentication flow and the HOPE submission XML schema are not in this repository — `packages/
// iqies-client`'s own header says the live transport binds "with the per-tenant credential wiring from
// M34's secret store", and `CHARTWARDEN_INTEGRATIONS_v0_1.md` §6.7 specifies the integration's SHAPE
// (outbound batch, acceptance report retrieved, per-ProviderEntity submitter credentials, sandbox vs
// prod) and no protocol details. Everything here is written against the typed `IqiesAdapter` port, so
// binding a real transport is implementing three methods.
//
// The difference that makes is not cosmetic. Before, an unconfigured deployment's batches sat `queued`
// in silence. Now the submit worker picks one, the deny-stub raises a `retryable: false` DegradedError,
// the job DLQs and the M36 DLQ alert fires. The backlog is VISIBLE, which is what lets the
// `assemble-hope-submission` cron be registered at all (see cron-workers.ts).
//
// TENANCY. Every query carries an explicit `organization_id` predicate on top of the caller's
// `withOrgContext` RLS envelope — the org-rollup store's HARD RULE 1, as in ./assemble-store.ts.
import { type DbClient, schema } from "@chartwarden/db";
import type { HopeDischargeReason, HopeRfaKind, HopeSubmissionStatus } from "@chartwarden/types";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { correctsIqiesRecordIdSql } from "./correlated-sql";

const ASSESS = schema.hopeAssessments;
const SUB = schema.hopeSubmissions;
const ITEM = schema.hopeSubmissionItems;
const FINDING = schema.hopeValidationFindings;

/**
 * A batch the submit worker may pick.
 *
 * NO CCN here, deliberately. `provider_entity` is an M1 FOUNDATION table M10 neither owns nor may
 * import (`arch:tables` — cross-module reads go through the owner, never its Drizzle schema), so the
 * envelope's CMS Certification Number is resolved through the `ProviderEntityCcnPort` the composition
 * root binds. Same rule that put `buildPrimaryProviderEntityResolver` in `bootstrap/` for M6 and M30.
 */
export interface PickedSubmission {
  readonly submissionId: string;
  readonly providerEntityId: string;
  readonly submissionPeriod: string;
  readonly status: HopeSubmissionStatus;
}

/** One item of a picked batch, carrying everything the pre-submission re-validation needs. */
export interface PickedSubmissionItem {
  readonly hopeAssessmentId: string;
  readonly rfaKind: HopeRfaKind;
  readonly dischargeReason: HopeDischargeReason | null;
  readonly data: unknown;
  readonly targetDate: Date;
  /** NOT NULL on `hope_validation_finding`; a rejected item cannot record its finding without them. */
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly correctsIqiesRecordId: string | null;
}

/**
 * `queued` batches in this org, oldest first.
 *
 * `limit` bounds one tick's work; a backlog drains over successive ticks rather than in one transaction
 * that could run for minutes holding an RLS connection open.
 */
export async function queuedSubmissionsForOrg(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<readonly PickedSubmission[]> {
  const rows = await tx
    .select({
      submissionId: SUB.id,
      providerEntityId: SUB.providerEntityId,
      submissionPeriod: SUB.submissionPeriod,
      status: SUB.status,
    })
    .from(SUB)
    .where(and(eq(SUB.organizationId, organizationId), eq(SUB.status, "queued")))
    .orderBy(asc(SUB.createdAt))
    .limit(limit);
  return rows;
}

/**
 * `in_flight` batches that actually reached iQIES — i.e. carry an `iqies_batch_id`.
 *
 * An `in_flight` row WITHOUT one is a transmit that failed after the CAS and before the adapter
 * answered; the submit worker rolls those back itself (see `releaseSubmission`). Asking the reconcile
 * worker to fetch an acceptance report for a batch CMS never received would turn a local failure into a
 * permanent adapter error every hour.
 */
export async function inFlightSubmissionsForOrg(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<readonly { submissionId: string; iqiesBatchId: string }[]> {
  const rows = await tx
    .select({ submissionId: SUB.id, iqiesBatchId: SUB.iqiesBatchId })
    .from(SUB)
    .where(
      and(
        eq(SUB.organizationId, organizationId),
        eq(SUB.status, "in_flight"),
        isNotNull(SUB.iqiesBatchId),
      ),
    )
    .orderBy(asc(SUB.transmittedAt))
    .limit(limit);
  return rows.map((r) => ({ submissionId: r.submissionId, iqiesBatchId: String(r.iqiesBatchId) }));
}

/**
 * The items of one batch, joined to their assessments.
 *
 * `hope_assessment` is PARTITION BY RANGE on `target_date` and `hope_submission_item.hope_assessment_id`
 * is a plain uuid (the composite-PK FK is impractical, per the schema note), so this is a join on id
 * alone across every partition. `pending` only: a re-run after a partial reconcile must not re-validate
 * an item iQIES has already answered on.
 */
export async function pendingItemsForSubmission(
  tx: DbClient,
  organizationId: string,
  submissionId: string,
): Promise<readonly PickedSubmissionItem[]> {
  const rows = await tx
    .select({
      hopeAssessmentId: ITEM.hopeAssessmentId,
      rfaKind: ASSESS.rfaKind,
      dischargeReason: ASSESS.dischargeReason,
      data: ASSESS.data,
      targetDate: ASSESS.targetDate,
      providerEntityId: ASSESS.providerEntityId,
      locationId: ASSESS.locationId,
      // Correct here TODAY only because this select has a join and Drizzle therefore qualifies the
      // column; the identical fragment one file over did not, and answered null for every correction
      // ever assembled. Through the shared helper so it cannot depend on that again (F-086).
      correctsIqiesRecordId: correctsIqiesRecordIdSql(ASSESS, ASSESS.correctsAssessmentId),
    })
    .from(ITEM)
    .innerJoin(ASSESS, eq(ASSESS.id, ITEM.hopeAssessmentId))
    .where(
      and(
        eq(ITEM.organizationId, organizationId),
        eq(ITEM.hopeSubmissionId, submissionId),
        eq(ITEM.itemStatus, "pending"),
      ),
    )
    .orderBy(asc(ITEM.hopeAssessmentId));
  return rows;
}

/**
 * Compare-and-set `queued` → `in_flight`. Returns false when the CAS lost.
 *
 * The predicate on `status = 'queued'` is the whole point: two workers may both read the same batch, and
 * exactly one may transmit it. The loser sees `false` and skips, which is the `{ action: "skip", reason:
 * "not_queued" }` branch `decideSubmitReadiness` already models.
 */
export async function claimSubmissionForTransmit(
  tx: DbClient,
  organizationId: string,
  submissionId: string,
): Promise<boolean> {
  const rows = await tx
    .update(SUB)
    .set({ status: "in_flight", updatedAt: new Date() })
    .where(
      and(
        eq(SUB.id, submissionId),
        eq(SUB.organizationId, organizationId),
        eq(SUB.status, "queued"),
      ),
    )
    .returning({ id: SUB.id });
  return rows.length === 1;
}

/**
 * Put a claimed batch back to `queued` after a transmit that did not complete.
 *
 * Guarded on `iqies_batch_id IS NULL` so it can never un-transmit a batch CMS actually received. The
 * retry is safe because `SubmitBatchRequest.correlationId` is derived from the submission id and is
 * therefore stable across attempts — the at-least-once-plus-idempotency-key posture
 * `CHARTWARDEN_INTEGRATIONS_v0_1.md` §5 prescribes for every outbox-driven external call.
 */
export async function releaseSubmission(
  tx: DbClient,
  organizationId: string,
  submissionId: string,
): Promise<void> {
  await tx
    .update(SUB)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(SUB.id, submissionId),
        eq(SUB.organizationId, organizationId),
        eq(SUB.status, "in_flight"),
        isNull(SUB.iqiesBatchId),
      ),
    );
}

/** Record a successful transmit — the `planTransmitResult` projection, applied. */
export async function recordTransmit(
  tx: DbClient,
  organizationId: string,
  input: {
    readonly submissionId: string;
    readonly iqiesBatchId: string;
    readonly envelopeStorageUri: string | null;
    readonly envelopeSha256: string;
    readonly transmittedAt: string;
  },
): Promise<void> {
  await tx
    .update(SUB)
    .set({
      iqiesBatchId: input.iqiesBatchId,
      envelopeStorageUri: input.envelopeStorageUri,
      envelopeSha256: input.envelopeSha256,
      transmittedAt: new Date(input.transmittedAt),
      updatedAt: new Date(),
    })
    .where(and(eq(SUB.id, input.submissionId), eq(SUB.organizationId, organizationId)));
}

/** Apply one `planReconcile` item transition: the join row, and the assessment's iQIES record id. */
export async function applyItemTransition(
  tx: DbClient,
  organizationId: string,
  submissionId: string,
  transition: {
    readonly hopeAssessmentId: string;
    readonly itemStatus: "accepted" | "rejected" | "pending";
    readonly iqiesRecordId: string | null;
  },
  validationResult: unknown,
): Promise<void> {
  await tx
    .update(ITEM)
    .set({
      itemStatus: transition.itemStatus,
      iqiesRecordId: transition.iqiesRecordId,
      iqiesValidationResult: validationResult as never,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ITEM.organizationId, organizationId),
        eq(ITEM.hopeSubmissionId, submissionId),
        eq(ITEM.hopeAssessmentId, transition.hopeAssessmentId),
      ),
    );

  // Only acceptance stamps the assessment. `hope_assessment.iqies_record_id` is the TERMINAL marker the
  // assembler reads (`iqies_record_id IS NULL` is half its eligibility rule), so writing it for a
  // rejected item would make a rejection permanently unsubmittable.
  if (transition.itemStatus === "accepted" && transition.iqiesRecordId !== null) {
    await tx
      .update(ASSESS)
      .set({ iqiesRecordId: transition.iqiesRecordId, updatedAt: new Date() })
      .where(
        and(eq(ASSESS.id, transition.hopeAssessmentId), eq(ASSESS.organizationId, organizationId)),
      );
  }
}

/** Fold the reconcile plan's batch-level outcome onto the `hope_submission` row. */
export async function recordReconcileOutcome(
  tx: DbClient,
  organizationId: string,
  input: {
    readonly submissionId: string;
    readonly nextStatus: HopeSubmissionStatus;
    readonly acceptedCount: number;
    readonly rejectedCount: number;
    readonly acceptanceReport: unknown;
    readonly at: Date;
  },
): Promise<void> {
  await tx
    .update(SUB)
    .set({
      status: input.nextStatus,
      acceptedCount: input.acceptedCount,
      rejectedCount: input.rejectedCount,
      // Only a batch with at least one acceptance has an acceptance instant; a wholly rejected batch
      // has an answer but nothing was accepted, and stamping `accepted_at` on it would make the column
      // mean "answered" rather than what it says.
      acceptedAt: input.acceptedCount > 0 ? input.at : null,
      acceptanceReport: input.acceptanceReport as never,
      updatedAt: input.at,
    })
    .where(and(eq(SUB.id, input.submissionId), eq(SUB.organizationId, organizationId)));
}

/**
 * Write the `hope_validation_finding` rows a rejection (from CMS or from the local pre-transmit gate)
 * produces.
 *
 * `provider_entity_id` / `location_id` are NOT NULL on this table. Before F-058 they were unreadable —
 * `hope_assessment` carried NULL in both — and the two existing finding writers each logged and skipped
 * when siting could not be resolved. It is stamped now, so the skip path is gone; a row that still
 * cannot be sited is returned as a count so the caller can say so rather than lose it.
 */
export async function writeValidationFindings(
  tx: DbClient,
  organizationId: string,
  findings: ReadonlyArray<{
    readonly hopeAssessmentId: string;
    readonly providerEntityId: string | null;
    readonly locationId: string | null;
    readonly ruleId: string;
    readonly severity: "error" | "warning";
    readonly section: string;
    readonly message: string;
  }>,
  at: Date,
): Promise<{ written: number; unsited: number }> {
  const writable = findings.filter((f) => f.providerEntityId !== null && f.locationId !== null);
  if (writable.length > 0) {
    await tx.insert(FINDING).values(
      writable.map((f) => ({
        organizationId,
        providerEntityId: f.providerEntityId as string,
        locationId: f.locationId as string,
        hopeAssessmentId: f.hopeAssessmentId,
        ruleId: f.ruleId,
        severity: f.severity,
        section: f.section,
        message: f.message,
        evaluatedAt: at,
        resolved: false,
      })),
    );
  }
  return { written: writable.length, unsited: findings.length - writable.length };
}
