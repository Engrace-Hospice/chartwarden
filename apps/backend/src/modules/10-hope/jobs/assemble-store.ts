// apps/backend/src/modules/10-hope/jobs/assemble-store.ts — the Drizzle read/write half of
// `assemble-hope-submission` (§4.10 stage 1), F-058 / #150.
//
// WHAT THIS FIXES. `hope_submission_item` had NO writer anywhere in the repo. The only non-schema
// references were the eraser (deleting rows nothing created) and the M10 RLS live suite (inserting its
// own). The pure batching planner it exists to serve — `planAssembleSubmissions` in ./submission.ts —
// shipped with M10-T07, unit-tested, with zero production callers, and the one route that claims to run
// it (`POST /api/v1/hope/submissions/assemble`, "force-assemble a submission outside the cron cadence")
// ignored it entirely: it inserted a `hope_submission` with `itemCount: 0` and no items at all, then
// emitted `m10.hope.submission_queued` with `itemCount: 0`. Every call produced an empty batch and
// reported 201 Created.
//
// SCOPE. This is stage 1 of the three §4.10 stages. Stages 2 and 3 terminate in `@chartwarden/iqies-client`,
// whose sole adapter is `createUnboundIqiesAdapter` — a deny-stub, because iQIES has no submission API (CMS
// HOPE FAQs Q30); submission is the manual package upload. That is a genuine
// declared absence, and `./cron-workers.ts` states it. Stage 1 is different: it needs nothing outside
// M10, and it runs NIGHTLY — F-072 registered `assemble-hope-submission` as a repeatable 02:00 cron.
// Which is why the F-086 defect below mattered: it is not a button someone might press twice.
//
// TENANCY. Every query carries an explicit `organization_id` predicate on top of the caller's
// `withOrgContext` RLS envelope — the org-rollup store's HARD RULE 1, reused here.
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { correctsIqiesRecordIdSql, outerColumn } from "./correlated-sql";
import { type AssemblableAssessment, submissionPeriodFor } from "./submission";

const ASSESS = schema.hopeAssessments;
const SUB = schema.hopeSubmissions;
const ITEM = schema.hopeSubmissionItems;

/** What one eligibility read found — the plannable rows PLUS what it could not plan, and why. */
export interface AssemblableScan {
  readonly eligible: readonly AssemblableAssessment[];
  /**
   * Signed, unsubmitted assessments whose `provider_entity_id` is NULL.
   *
   * `hope_submission.provider_entity_id` is NOT NULL — the CCN is the batch key — so an unsited
   * assessment cannot be placed in any batch. Counted and returned rather than dropped inside the
   * WHERE clause: an assessment that is silently invisible to the assembler is exactly the failure
   * this whole change exists to end.
   */
  readonly unsitedAssessmentIds: readonly string[];
}

/**
 * Every assessment in `organizationId` that stage 1 may batch, plus the unsited ones it cannot.
 *
 * Eligibility (§4.10): `status = 'signed'` AND not superseded AND `iqies_record_id IS NULL`. The
 * "already on an active item" half is NOT a filter — it is projected onto each row as
 * `hasActiveSubmissionItem` so `planAssembleSubmissions` reports it as a skip, which is what makes a
 * re-run's idempotency observable instead of merely true.
 *
 * That projection answered `false` for every row the platform ever read (F-086), so the idempotency it
 * exists to express did not hold: a SECOND assemble pass re-selected everything the first had batched
 * and the insert hit `uniq_hope_sub_item_assessment_active`, aborting the whole transaction. The index
 * is documented as "the backstop under two concurrent assemblers" and it was in fact the only thing
 * standing between a sequential re-run and a double-batch — so `POST /hope/submissions/assemble`
 * answered 500 on its second press, forever, for every tenant.
 *
 * `providerEntityId` narrows to non-null only for the ELIGIBLE set; the unsited rows are returned
 * beside it. `submissionPeriod` is derived from `target_date` — see {@link submissionPeriodFor} for why
 * the clock is the wrong anchor.
 */
export async function assemblableAssessmentsForOrg(
  tx: DbClient,
  organizationId: string,
  providerEntityId?: string,
): Promise<AssemblableScan> {
  const rows = await tx
    .select({
      id: ASSESS.id,
      providerEntityId: ASSESS.providerEntityId,
      rfaKind: ASSESS.rfaKind,
      targetDate: ASSESS.targetDate,
      signedAt: ASSESS.signedAt,
      iqiesRecordId: ASSESS.iqiesRecordId,
      // The correction chain (D7): a Correction RFA references the ACCEPTED original's iQIES record id.
      // Resolved by self-join on `corrects_assessment_id` — null for an ordinary first submission and
      // for a correction whose original was never accepted, which is the `skip` branch of
      // `planCorrectionRfa`.
      correctsIqiesRecordId: correctsIqiesRecordIdSql(ASSESS, ASSESS.correctsAssessmentId),
      // NOT a filter — projected so `planAssembleSubmissions` reports it as a skip, which is what makes
      // a re-run's idempotency OBSERVABLE rather than merely true. It answered `false` for every row
      // ever read until F-086: the outer column rendered unqualified as `"id"`, which inside
      // `from hope_submission_item i` is `i.id`, so the predicate was `i.hope_assessment_id = i.id`.
      hasActiveItem: sql<boolean>`exists (select 1 from hope_submission_item i where i.hope_assessment_id = ${outerColumn(
        ASSESS,
        ASSESS.id,
      )} and i.item_status = 'pending')`,
    })
    .from(ASSESS)
    .where(
      and(
        eq(ASSESS.organizationId, organizationId),
        eq(ASSESS.status, "signed"),
        isNull(ASSESS.supersededById),
        isNull(ASSESS.iqiesRecordId),
        ...(providerEntityId ? [eq(ASSESS.providerEntityId, providerEntityId)] : []),
      ),
    )
    .orderBy(asc(ASSESS.targetDate), asc(ASSESS.id));

  const eligible: AssemblableAssessment[] = [];
  const unsited: string[] = [];
  for (const r of rows) {
    if (r.providerEntityId === null) {
      unsited.push(r.id);
      continue;
    }
    eligible.push({
      assessmentId: r.id,
      providerEntityId: r.providerEntityId,
      submissionPeriod: submissionPeriodFor(r.targetDate.toISOString()),
      rfaKind: r.rfaKind,
      // A signed row always has `signed_at`; the fallback keeps the sort total rather than throwing on
      // a row an older write path left unstamped.
      signedAt: (r.signedAt ?? r.targetDate).toISOString(),
      hasActiveSubmissionItem: r.hasActiveItem === true,
      iqiesRecordId: r.iqiesRecordId,
      correctsIqiesRecordId: r.correctsIqiesRecordId,
    });
  }
  return { eligible, unsitedAssessmentIds: unsited };
}

/** One persisted batch: the inserted `hope_submission` row beside the assessments placed on it. */
export interface PersistedSubmission {
  readonly submission: typeof SUB.$inferSelect;
  readonly assessmentIds: readonly string[];
}

/**
 * Persist one planned batch: the `hope_submission` row and its `hope_submission_item` rows, in the
 * caller's transaction.
 *
 * The item insert is the whole point of this file, and it is what makes `uniq_hope_sub_item_assessment_active`
 * load-bearing: with no writer the partial unique index on `(hope_assessment_id) WHERE item_status =
 * 'pending'` guarded nothing. It is the backstop under two concurrent assemblers, where both read the
 * same eligible set before either writes — the second INSERT raises rather than double-batching an
 * assessment.
 */
export async function persistAssembledSubmission(
  tx: DbClient,
  organizationId: string,
  planned: {
    readonly providerEntityId: string;
    readonly submissionPeriod: string;
    readonly items: ReadonlyArray<{ readonly hopeAssessmentId: string }>;
  },
): Promise<PersistedSubmission> {
  const [row] = await tx
    .insert(SUB)
    .values({
      organizationId,
      providerEntityId: planned.providerEntityId,
      submissionPeriod: planned.submissionPeriod,
      status: "queued",
      itemCount: planned.items.length,
    })
    .returning();
  if (!row) throw new Error("hope_submission insert returned no row");

  await tx.insert(ITEM).values(
    planned.items.map((i) => ({
      organizationId,
      hopeSubmissionId: row.id,
      hopeAssessmentId: i.hopeAssessmentId,
      itemStatus: "pending" as const,
    })),
  );

  return { submission: row, assessmentIds: planned.items.map((i) => i.hopeAssessmentId) };
}

/**
 * How many of an org's `hope_submission` rows were assembled and never transmitted.
 *
 * Feeds the §1.3 acceptance-rate measure's availability decision (see
 * `computeHopeSubmissionAcceptanceRate`): a zero denominator with queued batches behind it is not
 * "too few to report", it is "nothing has ever been transmitted", and those two must not present to a
 * surveyor as the same blank cell.
 */
export async function queuedSubmissionCountForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(SUB)
    .where(
      and(
        eq(SUB.organizationId, organizationId),
        eq(SUB.status, "queued"),
        isNull(SUB.transmittedAt),
      ),
    );
  return rows[0]?.n ?? 0;
}
