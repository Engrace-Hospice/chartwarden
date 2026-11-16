// apps/backend/src/modules/10-hope/hope-sfv-completion-record.ts — `recordSfv`: complete an open Symptom Follow-Up
// Visit by inserting the signed RFA-04 that completes it (§2.2.3). Split out of `hope-route-service-db.ts`; the
// guards it runs live in ./hope-sfv-completion-guards.ts and ./hope-sfv-completion-content.ts, the answer writer in
// ./hope-sfv-completion-answers.ts.
//
// THE ORDER IS SECURITY-RELEVANT: attestation -> calendar date (pure, body only) -> M6 seam read (outside the tx:
// another module's seam opens its own tenant context) -> locked, admission-bound SFV lookup -> patient equality ->
// J2052/J2053 content -> only then the signed insert, `planSfvCompletion`, the guarded UPDATE, the signature audit,
// the answer write and the event. Lock order inside the tx: SFV row, then the triggering assessment, then its answers.
import { type DbClient, schema } from "@chartwarden/db";
import {
  HopeStateError,
  captureInstantOf,
  planSfvCompletion,
  requireAttestation,
  require_,
} from "@chartwarden/hope";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { requireCalendarTargetDate } from "./hope-calendar-date";
import { writeDraftSfvCompletionAnswers } from "./hope-sfv-completion-answers";
import {
  requireValidSfvCompletionContent,
  sfvCompletionInvalidMessage,
} from "./hope-sfv-completion-content";
import {
  auditSfvCompletionRefusal,
  isSfvNoTriggerRefusal,
  lockSfvForCompletion,
  requireSfvBoundToAdmission,
  resolveSfvAdmissionPatient,
} from "./hope-sfv-completion-guards";
import { withSfvCompletedDate } from "./hope-sfv-completion-plan";
import type { HopeSignEmit } from "./hope-sign-tail";
import {
  HOPE_SFV_STEP_UP_OPERATION,
  type HopeAuditRequestFacts,
  auditHopeSignature,
} from "./hope-signature-audit";
import { uuidOrNotFound } from "./hope-uuid";
import type { HopeAssessmentView, RecordSfvArgs } from "./routes/service";

const ASSESS = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;

type AssessmentRow = typeof ASSESS.$inferSelect;
type SfvRow = typeof SFV.$inferSelect;

/**
 * The SFV states a completion may leave (mirrors `planSfvCompletion`: not `completed`, not `withdrawn`).
 * Defence in depth: the SFV is read `FOR UPDATE` and `planSfvCompletion` has already refused `completed`/`withdrawn`,
 * so the guarded UPDATE cannot miss today. It stays so that a later edit that drops the lock or the plan call cannot
 * silently overwrite a terminal state.
 */
const SFV_COMPLETABLE_STATUSES: SfvRow["status"][] = ["open", "overdue", "missed"];

/** What the recorder needs from the backend that owns it (the outbox, the clock, the late-override audit, the view). */
interface SfvCompletionDeps {
  readonly db: DbClient;
  readonly clock: () => Date;
  readonly emit: HopeSignEmit;
  readonly auditDeadlineOverride: (
    tx: DbClient,
    organizationId: string,
    membershipId: string,
    resource: { kind: string; id: string },
    context: Record<string, unknown>,
    request?: HopeAuditRequestFacts,
  ) => Promise<void>;
  readonly toView: (row: AssessmentRow) => HopeAssessmentView;
}

const isoOf = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** The signed RFA-04 row a completion inserts, carrying the SFV's own patient, admission and siting. */
async function insertSignedSfvAssessment(
  t: DbClient,
  organizationId: string,
  userId: string,
  sfv: SfvRow,
  args: RecordSfvArgs,
  completedDate: string,
  at: Date,
): Promise<AssessmentRow> {
  const [row] = (await t
    .insert(ASSESS)
    .values({
      organizationId,
      patientId: sfv.patientId,
      // The SFV's own admission (== the URL's, by the scoped lookup): the row never pairs one
      // patient with another admission's id.
      admissionId: sfv.admissionId,
      // F-058 — the batch key, carried from the SFV obligation this RFA-04 completes (the same
      // denormalized siting, already resolved when the trigger created it).
      providerEntityId: sfv.providerEntityId,
      locationId: sfv.locationId,
      rfaKind: "04_sfv",
      status: "signed",
      // The client's payload plus the calendar date AS WRITTEN (server-owned, overwriting any client value of that key):
      // the review heal rebuilds a missing J2052B from it instead of from the stored instant's UTC day.
      data: withSfvCompletedDate(args.data, completedDate),
      authorDiscipline: args.authorDiscipline as AssessmentRow["authorDiscipline"],
      targetDate: new Date(args.targetDate),
      signedAt: at,
      signedByMembershipId: userId,
      createdByMembershipId: userId,
    })
    .returning()) as AssessmentRow[];
  if (!row) throw new NotFoundError("hope_assessment (sfv) insert returned no row");
  return row;
}

/**
 * Flip the SFV to `completed` while it is still in a completable state. Defence in depth, unreachable today (see
 * {@link SFV_COMPLETABLE_STATUSES}); a miss is reported as the ALREADY_COMPLETED case.
 */
export async function closeCompletedSfv(
  t: DbClient,
  organizationId: string,
  sfv: SfvRow,
  completingAssessmentId: string,
  at: Date,
): Promise<void> {
  const completed = await t
    .update(SFV)
    .set({ status: "completed", completingAssessmentId, completedAt: at, updatedAt: at })
    .where(
      and(
        eq(SFV.id, sfv.id),
        eq(SFV.organizationId, organizationId),
        inArray(SFV.status, SFV_COMPLETABLE_STATUSES),
      ),
    )
    .returning({ id: SFV.id });
  require_(
    completed.length === 1,
    "M10_SFV_ALREADY_COMPLETED",
    `Symptom-follow-up-visit ${sfv.id} is already completed.`,
  );
}

/** Write the completion's J2052/J2053 answers onto the still-draft triggering assessment, or refuse (rolling back). */
async function writeAnswersOrRefuse(
  t: DbClient,
  organizationId: string,
  sfv: SfvRow,
  answerPlan: Parameters<typeof writeDraftSfvCompletionAnswers>[3],
  at: Date,
): Promise<void> {
  const written = await writeDraftSfvCompletionAnswers(
    t,
    organizationId,
    sfv.triggeringAssessmentId,
    answerPlan,
    at,
  );
  // Unreachable unless the triggering assessment's spec was frozen after the content check ran; the whole
  // transaction (RFA-04, SFV, audit row) then rolls back with the refusal.
  if (written.status === "invalid") {
    throw new HopeStateError(
      "M10_SFV_COMPLETION_INCOMPLETE",
      sfvCompletionInvalidMessage(written.itemCodes),
    );
  }
}

/** The caller-bound guards: the admission's SFV, locked, bound to the URL admission, with valid J2052/J2053 content. */
async function guardedSfv(
  t: DbClient,
  input: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly admissionId: string;
    readonly admissionPatientId: string;
    readonly args: RecordSfvArgs;
    readonly completedDate: string;
  },
) {
  const { organizationId, admissionId, args } = input;
  const sfv = await lockSfvForCompletion(
    t,
    organizationId,
    admissionId,
    args.triggeringAssessmentId,
  );
  requireSfvBoundToAdmission(sfv, input.admissionPatientId, {
    organizationId,
    membershipId: input.membershipId,
    admissionId,
    triggeringAssessmentId: args.triggeringAssessmentId,
  });
  const answerPlan = await requireValidSfvCompletionContent(t, organizationId, sfv, {
    completedDate: input.completedDate,
    data: args.data,
  });
  return { sfv, answerPlan };
}

/** The deadline-override audit: written only when the override actually lifted the due date (the late filing it let through). */
async function auditOverrideIfLifted(
  deps: SfvCompletionDeps,
  t: DbClient,
  caller: { readonly organizationId: string; readonly userId: string },
  facts: {
    readonly args: RecordSfvArgs;
    readonly assessmentId: string;
    readonly sfvId: string;
    readonly completedAtIso: string;
    readonly dueAtIso: string;
  },
): Promise<void> {
  const { args } = facts;
  if (args.adminOverride !== true) return;
  if (Date.parse(facts.completedAtIso) <= Date.parse(facts.dueAtIso)) return;
  await deps.auditDeadlineOverride(
    t,
    caller.organizationId,
    caller.userId,
    { kind: "hope_assessment", id: facts.assessmentId },
    {
      sfvId: facts.sfvId,
      triggeringAssessmentId: args.triggeringAssessmentId,
      targetDate: args.targetDate,
      // The typed reason is kept in the immutable event (screened for patient identifiers by the route guard and again by
      // `auditDeadlineOverride`): it is the only record of why the due date was lifted.
      justification: args.adminOverrideJustification ?? null,
    },
    args.request,
  );
}

/**
 * GAP-015: completion is judged on the later of the client's `targetDate` and the SERVER's now, so a late filer cannot
 * send an in-window date to dodge `M10_SFV_PAST_DUE`; the due instant is the SFV's own (now, when it carries none).
 */
function completionInstants(args: RecordSfvArgs, sfv: SfvRow, at: Date) {
  return {
    completedAtIso: captureInstantOf(args.targetDate, at.toISOString()),
    dueAtIso: isoOf(sfv.dueAt) ?? at.toISOString(),
  };
}

/** The evidence a completion leaves beside its rows: the signature audit, the J2052/J2053 answers, the event. */
async function recordCompletionEvidence(
  deps: SfvCompletionDeps,
  t: DbClient,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly args: RecordSfvArgs;
    readonly attestationConfirmed: true;
    readonly sfv: SfvRow;
    readonly assessment: AssessmentRow;
    readonly answerPlan: Parameters<typeof writeDraftSfvCompletionAnswers>[3];
    readonly at: Date;
  },
): Promise<void> {
  const { organizationId, userId, args, sfv, assessment, at } = input;
  await auditHopeSignature(t, {
    organizationId,
    membershipId: userId,
    eventType: "hope.sfv_completed",
    assessmentId: assessment.id,
    rfaKind: "04_sfv",
    version: assessment.version,
    stepUpRequiredOperation: HOPE_SFV_STEP_UP_OPERATION,
    sfvId: sfv.id,
    attestationConfirmed: input.attestationConfirmed,
    attestationVersion: args.attestationVersion,
    ...args.request,
  });
  await writeAnswersOrRefuse(t, organizationId, sfv, input.answerPlan, at);
  await deps.emit(t, organizationId, "m10.hope.sfv_completed", "symptom_follow_up_visit", sfv.id, {
    sfvId: sfv.id,
    completingAssessmentId: assessment.id,
    completedAt: at.toISOString(),
  });
}

/** Everything `recordSfv` does inside its tenant transaction, in the order the file header fixes. */
async function completeSfvInTx(
  deps: SfvCompletionDeps,
  t: DbClient,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly admissionId: string;
    readonly admissionPatientId: string;
    readonly args: RecordSfvArgs;
    readonly completedDate: string;
    readonly attestationConfirmed: true;
  },
): Promise<HopeAssessmentView> {
  const { organizationId, userId, args } = input;
  const { sfv, answerPlan } = await guardedSfv(t, {
    organizationId,
    membershipId: userId,
    admissionId: input.admissionId,
    admissionPatientId: input.admissionPatientId,
    args,
    completedDate: input.completedDate,
  });
  // The clock is read AFTER the SFV lock wait and the content guard, so a completion that queued is stamped when it completes.
  const at = deps.clock();
  const { completedAtIso, dueAtIso } = completionInstants(args, sfv, at);
  // Insert the signed RFA-04 row, then complete the open SFV (the §4.4 guards live in planSfvCompletion).
  const row = await insertSignedSfvAssessment(
    t,
    organizationId,
    userId,
    sfv,
    args,
    input.completedDate,
    at,
  );
  const plan = planSfvCompletion(
    { id: sfv.id, status: sfv.status, dueAt: dueAtIso },
    row.id,
    completedAtIso,
    { adminOverride: args.adminOverride },
  );
  await auditOverrideIfLifted(
    deps,
    t,
    { organizationId, userId },
    { args, assessmentId: row.id, sfvId: sfv.id, completedAtIso, dueAtIso },
  );
  await closeCompletedSfv(t, organizationId, sfv, plan.completingAssessmentId, at);
  await recordCompletionEvidence(deps, t, {
    organizationId,
    userId,
    args,
    attestationConfirmed: input.attestationConfirmed,
    sfv,
    assessment: row,
    answerPlan,
    at,
  });
  return deps.toView(row);
}

/** `recordSfv`, bound to the backend's database, clock, outbox and late-override audit. */
export function createSfvCompletionRecorder(deps: SfvCompletionDeps) {
  return async function recordSfv(
    organizationId: string,
    userId: string,
    urlAdmissionId: string,
    args: RecordSfvArgs,
  ): Promise<HopeAssessmentView> {
    // The service itself refuses an unattested signature (not only the route's schema).
    const attestationConfirmed = args.attestationConfirmed;
    requireAttestation(attestationConfirmed, args.attestationVersion);
    // A date that exists: J2052B is the date as the clinician wrote it, and a Feb 30 is refused, not rolled to Mar 2.
    const completedDate = requireCalendarTargetDate(args.targetDate);
    // The admission as Postgres writes it, and a 404 for an id that is no uuid (the `hope.scope` gate answers the same
    // today): before the M6 seam read and the locked SFV lookup, which compare it with uuid columns.
    const admissionId = uuidOrNotFound(urlAdmissionId, `Admission ${urlAdmissionId} not found`);
    const admissionPatientId = await resolveSfvAdmissionPatient(organizationId, admissionId);
    try {
      return await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) =>
        completeSfvInTx(deps, tx as unknown as DbClient, {
          organizationId,
          userId,
          admissionId,
          admissionPatientId,
          args,
          completedDate,
          attestationConfirmed,
        }),
      );
    } catch (error) {
      // The unbound-SFV refusal rolled the transaction back, so its `denied` audit event is written now, on a new one
      // (best effort: it never replaces the refusal the caller receives).
      if (isSfvNoTriggerRefusal(error)) {
        await auditSfvCompletionRefusal(
          deps.db,
          {
            organizationId,
            membershipId: userId,
            admissionId,
            triggeringAssessmentId: args.triggeringAssessmentId,
          },
          args.request,
        );
      }
      throw error;
    }
  };
}
