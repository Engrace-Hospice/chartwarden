// apps/backend/src/modules/10-hope/hope-sfv-completion-answers.ts — writing a completed SFV's regulatory
// (J2052/J2053) answers onto its still-DRAFT triggering assessment, and the review self-heal that repairs them.
//
// LOCK ORDER. Every writer that takes more than one of these rows takes them in this order, so none can form a
// cycle with another:
//   SFV row  ->  triggering assessment row  ->  its answer rows
// `recordSfv` (SFV `FOR UPDATE`, then this writer) and the review self-heal (SFV `FOR UPDATE` first, then this
// writer) follow it literally. `patchAnswers` follows it too: it locks the SFV row first (`lockTriggeredSfv`), then the
// assessment row (`lockAssessmentRow`, judged again on the locked row), and only then writes answers and, last, the
// assessment's version bump, so it never waits for a lock while holding one a writer ahead of it in the order wants.
// `signTimepoint` takes the assessment row and its own Z0500B answer only, never an SFV lock, so it cannot close a cycle
// either.
// A record that is not a draft takes NO lock here at all: the status is checked unlocked first, and only a draft is
// then locked (and re-judged on the locked row).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { takeBoundedLock } from "./hope-assessment-lock";
import { isRealCalendarDate } from "./hope-calendar-date";
import { idForLog } from "./hope-log-id";
import {
  type SfvRegulatoryItem,
  invalidSfvRegulatoryItemCodes,
  loadSfvRegulatoryItems,
} from "./hope-sfv-completion-content";
import {
  type CompletedSfvRegulatoryAnswerPlan,
  buildCompletedSfvRegulatoryAnswerPlan,
  serverRecordedCompletedDate,
} from "./hope-sfv-completion-plan";
import type { HopeIsc } from "./hope-spec-registry";

const ASSESS = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;
const ANSWER = schema.hopeAssessmentAnswers;

type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;

/**
 * What a write did. `not_applicable`: nothing to write onto (no such draft, no frozen spec/ISC). `unchanged`: the
 * stored answers already equal the plan, so nothing was written. `written`: at least one answer changed (and the draft's
 * version moved). `invalid`: the plan holds a value the CMS spec does not allow, so NOTHING was written.
 */
type SfvAnswerWrite =
  | { readonly status: "written" | "unchanged" | "not_applicable" }
  | { readonly status: "invalid"; readonly itemCodes: readonly string[] };

const RECONCILIATION_REFERENCE = {
  reason: "completed_sfv_regulatory_reconciliation",
  sfvWorkflow: "completed_operational_sfv",
} as const;
const J2052C_SKIP_REFERENCE = {
  ...RECONCILIATION_REFERENCE,
  ruleId: "hope-v1.00.1-j2052-reason",
  cmsRuleId: "-3106",
  dependsOn: ["J2052A"],
} as const;

interface DesiredAnswer {
  readonly item: SfvRegulatoryItem["item"];
  readonly state: "answered" | "skipped";
  readonly value: string | null;
  readonly sourceReference: Record<string, unknown>;
  /**
   * Written only while ABSENT: an existing answered + derived row counts as equal whatever its value. J2052B is the
   * date of the visit as the clinician WROTE it (in their own offset) when `recordSfv` first wrote it. `planOfCompletion`
   * rebuilds that date from the as-written date the server recorded, but a completion recorded before that date was kept
   * can only be re-derived from the stored instant's UTC day, which can be the next day, so a heal must never overwrite it.
   */
  readonly writeOnce?: boolean;
}

/** The J2052B "date of in-person SFV" answer, the one regulatory answer a heal must never change once written. */
const SFV_DATE_ITEM_CODE = "J2052B";

/** The J2052A/B + J2053A-H answers the plan carries (and the skipped J2052C), for the items the spec has active. */
function desiredAnswersOf(
  plan: CompletedSfvRegulatoryAnswerPlan,
  byCode: ReadonlyMap<string, SfvRegulatoryItem>,
): DesiredAnswer[] {
  const desired: DesiredAnswer[] = [];
  for (const [itemCode, value] of plan.answered) {
    const item = byCode.get(itemCode)?.item;
    if (item) {
      desired.push({
        item,
        state: "answered",
        value,
        sourceReference: RECONCILIATION_REFERENCE,
        ...(itemCode === SFV_DATE_ITEM_CODE ? { writeOnce: true } : {}),
      });
    }
  }
  const j2052c = byCode.get("J2052C")?.item;
  if (j2052c) {
    desired.push({
      item: j2052c,
      state: "skipped",
      value: null,
      sourceReference: J2052C_SKIP_REFERENCE,
    });
  }
  return desired;
}

async function upsertDerivedAnswer(
  tx: DbClient,
  assessment: AssessmentRow,
  desired: DesiredAnswer,
  at: Date,
): Promise<void> {
  const row = {
    state: desired.state,
    value: desired.value,
    source: "derived" as const,
    sourceReference: desired.sourceReference,
    answeredAt: at,
    answeredByMembershipId: null,
    updatedAt: at,
  };
  await tx
    .insert(ANSWER)
    .values({
      organizationId: assessment.organizationId,
      providerEntityId: assessment.providerEntityId,
      locationId: assessment.locationId,
      hopeAssessmentId: assessment.id,
      specVersionId: assessment.specVersionId as string,
      specItemId: desired.item.id,
      ...row,
    })
    .onConflictDoUpdate({ target: [ANSWER.hopeAssessmentId, ANSWER.specItemId], set: row });
}

/** The desired answers the draft does not already hold exactly (same state, value and `derived` source). */
async function answersToWrite(
  tx: DbClient,
  assessment: AssessmentRow,
  desired: readonly DesiredAnswer[],
): Promise<DesiredAnswer[]> {
  if (desired.length === 0) return [];
  const stored = await tx
    .select({
      specItemId: ANSWER.specItemId,
      state: ANSWER.state,
      value: ANSWER.value,
      source: ANSWER.source,
    })
    .from(ANSWER)
    .where(
      and(
        eq(ANSWER.hopeAssessmentId, assessment.id),
        inArray(
          ANSWER.specItemId,
          desired.map((d) => d.item.id),
        ),
      ),
    );
  const storedByItem = new Map(stored.map((row) => [row.specItemId, row]));
  return desired.filter((d) => {
    const row = storedByItem.get(d.item.id);
    if (!row) return true;
    if (row.state !== d.state || row.source !== "derived") return true;
    return d.writeOnce ? false : row.value !== d.value;
  });
}

type DraftAnswerInspection =
  | { readonly status: "not_applicable" | "unchanged" }
  | { readonly status: "invalid"; readonly itemCodes: readonly string[] }
  | {
      readonly status: "pending";
      readonly assessment: AssessmentRow;
      readonly changed: readonly DesiredAnswer[];
    };

/**
 * What the plan would change on the triggering assessment, read as the caller asks: UNLOCKED (a cheap read that can be
 * stale, used to decide whether any lock is worth taking) or `FOR UPDATE` (the row as locked, which the write judges).
 * `not_applicable`: no such draft, or no frozen spec/ISC to hold the answers. `invalid`: the plan holds a value the CMS
 * spec does not allow. `unchanged`: the stored answers already equal the plan.
 */
async function inspectDraftAnswers(
  tx: DbClient,
  organizationId: string,
  triggeringAssessmentId: string,
  plan: CompletedSfvRegulatoryAnswerPlan,
  lock: boolean,
): Promise<DraftAnswerInspection> {
  const select = (executor: DbClient) =>
    executor
      .select()
      .from(ASSESS)
      .where(and(eq(ASSESS.id, triggeringAssessmentId), eq(ASSESS.organizationId, organizationId)))
      .limit(1);
  // The locked read waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`) and retries once on the moved row.
  const [assessment] = (
    lock
      ? await takeBoundedLock(tx, (statement) => select(statement).for("update"), {
          retryMovedRow: true,
          lock: `triggering assessment ${idForLog(triggeringAssessmentId)} (org ${idForLog(organizationId)}) for an SFV completion`,
        })
      : await select(tx)
  ) as AssessmentRow[];
  if (assessment?.status !== "draft" || !assessment.specVersionId || !assessment.isc) {
    return { status: "not_applicable" };
  }
  const byCode = await loadSfvRegulatoryItems(tx, {
    specVersionId: assessment.specVersionId,
    isc: assessment.isc as HopeIsc,
  });
  const invalidCodes = invalidSfvRegulatoryItemCodes(plan, byCode);
  if (invalidCodes.length > 0) return { status: "invalid", itemCodes: invalidCodes };
  const changed = await answersToWrite(tx, assessment, desiredAnswersOf(plan, byCode));
  return changed.length === 0
    ? { status: "unchanged" }
    : { status: "pending", assessment, changed };
}

/**
 * Write a completed SFV's J2052/J2053 regulatory answers onto its still-DRAFT triggering assessment.
 *
 * The CALLER already holds the SFV row lock (see the lock order above). The plan is inspected UNLOCKED first, so a
 * signed or superseded record, or a draft that already holds exactly these answers, takes no lock; otherwise the
 * draft is inspected again `FOR UPDATE`, as `signTimepoint` does, and everything is judged on the LOCKED row: a sign
 * that committed first is seen as `signed` here, so a completion (or the review self-heal) can never upsert
 * regulatory answers onto a record a racing sign has just frozen. Answers the draft already holds exactly are not
 * rewritten (no churn, no audit rows for a no-op); when anything is written the draft's `version` and `updated_at`
 * move, so a signer who reviewed the older version loses with a 409 and reviews the new answers.
 */
export async function writeDraftSfvCompletionAnswers(
  tx: DbClient,
  organizationId: string,
  triggeringAssessmentId: string,
  plan: CompletedSfvRegulatoryAnswerPlan,
  at: Date,
): Promise<SfvAnswerWrite> {
  const unlocked = await inspectDraftAnswers(
    tx,
    organizationId,
    triggeringAssessmentId,
    plan,
    false,
  );
  if (unlocked.status !== "pending") return unlocked;
  const locked = await inspectDraftAnswers(tx, organizationId, triggeringAssessmentId, plan, true);
  if (locked.status !== "pending") return locked;
  for (const desired of locked.changed)
    await upsertDerivedAnswer(tx, locked.assessment, desired, at);
  await tx
    .update(ASSESS)
    .set({ version: sql`${ASSESS.version} + 1`, updatedAt: at })
    .where(and(eq(ASSESS.id, triggeringAssessmentId), eq(ASSESS.organizationId, organizationId)));
  return { status: "written" };
}

const sfvOfTrigger = (organizationId: string, triggeringAssessmentId: string) =>
  and(
    eq(SFV.organizationId, organizationId),
    eq(SFV.triggeringAssessmentId, triggeringAssessmentId),
  );

const isCompleted = (sfv: SfvRow | undefined): sfv is SfvRow =>
  sfv != null &&
  sfv.status === "completed" &&
  sfv.completedAt != null &&
  sfv.completingAssessmentId != null;

/** The server-recorded as-written completion date, when it is a date that exists (`null` otherwise). */
function recordedCompletedDate(data: Record<string, unknown>): string | null {
  const date = serverRecordedCompletedDate(data);
  const parts = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parts || !isRealCalendarDate(Number(parts[1]), Number(parts[2]), Number(parts[3])))
    return null;
  return date;
}

/**
 * The J2052/J2053 plan a completed SFV's RFA-04 carries, or why there is none. The J2052B date is the calendar date
 * `recordSfv` recorded server-side in the RFA-04's `data` (as the clinician wrote it, in their own offset); only a
 * completion recorded before that was kept falls back to the stored instant's UTC day. It is used when a heal finds NO
 * J2052B (the answer is write-once, so a date already written is never replaced).
 */
async function planOfCompletion(
  tx: DbClient,
  organizationId: string,
  sfv: SfvRow,
): Promise<{ readonly plan: CompletedSfvRegulatoryAnswerPlan } | { readonly reason: string }> {
  const [completion] = (await tx
    .select()
    .from(ASSESS)
    .where(
      and(
        eq(ASSESS.organizationId, organizationId),
        eq(ASSESS.id, sfv.completingAssessmentId as string),
      ),
    )
    .limit(1)) as AssessmentRow[];
  if (!completion || completion.rfaKind !== "04_sfv" || completion.status !== "signed") {
    return { reason: "completion_assessment_not_signed_sfv" };
  }
  const data =
    completion.data && typeof completion.data === "object" && !Array.isArray(completion.data)
      ? (completion.data as Record<string, unknown>)
      : null;
  if (!data) return { reason: "missing_sfv_data" };
  const plan = buildCompletedSfvRegulatoryAnswerPlan(
    recordedCompletedDate(data) ?? completion.targetDate.toISOString().slice(0, 10),
    data,
  );
  return plan ? { plan } : { reason: "missing_j2053" };
}

/**
 * Repair a still-draft triggering assessment whose SFV was completed but whose J2052/J2053 answers are missing or
 * differ (run when its review is loaded). A READ path: it reports why it did not repair rather than refusing.
 * Everything that decides whether there is anything to do is read UNLOCKED (the SFV, the plan, what the draft holds),
 * so the steady state (a review of a healed draft, a signed record, an SFV that is not completed) takes no lock and
 * writes nothing. Only when something differs is the SFV row locked, FIRST in the lock order, and judged again on the
 * locked row before the writer takes the assessment row.
 */
export async function reconcileCompletedSfvRegulatoryAnswers(
  tx: DbClient,
  organizationId: string,
  triggeringAssessmentId: string,
  at: Date = new Date(),
): Promise<{ repaired: boolean; reason?: string }> {
  const [peeked] = (await tx
    .select()
    .from(SFV)
    .where(sfvOfTrigger(organizationId, triggeringAssessmentId))
    .limit(1)) as SfvRow[];
  if (!isCompleted(peeked)) return { repaired: false, reason: "sfv_not_completed" };
  const derived = await planOfCompletion(tx, organizationId, peeked);
  if ("reason" in derived) return { repaired: false, reason: derived.reason };

  const inspected = await inspectDraftAnswers(
    tx,
    organizationId,
    triggeringAssessmentId,
    derived.plan,
    false,
  );
  // A completion recorded before the CMS values were checked can hold one the spec refuses: it is left
  // unwritten (this is a read path, so it reports rather than refuses).
  if (inspected.status === "invalid") return { repaired: false, reason: "invalid_j2053" };
  if (inspected.status !== "pending") {
    return {
      repaired: false,
      reason: inspected.status === "unchanged" ? "up_to_date" : "triggering_not_draft",
    };
  }

  const [sfv] = (await takeBoundedLock(
    tx,
    (statement) => statement.select().from(SFV).where(eq(SFV.id, peeked.id)).limit(1).for("update"),
    {
      lock: `SFV row of triggering assessment ${idForLog(triggeringAssessmentId)} (org ${idForLog(organizationId)}) for the review self-heal`,
    },
  )) as SfvRow[];
  if (!isCompleted(sfv)) return { repaired: false, reason: "sfv_not_completed" };
  const written = await writeDraftSfvCompletionAnswers(
    tx,
    organizationId,
    triggeringAssessmentId,
    derived.plan,
    at,
  );
  if (written.status === "invalid") return { repaired: false, reason: "invalid_j2053" };
  return { repaired: written.status === "written" };
}
