// apps/backend/src/modules/16-bereavement/render-payloads/request-discharge-summary.ts — ADR-0109 D9.
//
// ONE helper every closure writer calls, on the closure's own transaction, AFTER the closure row exists and the plan's future outreach has
// been cancelled (so the summary states the final state): it reads the rows the summary may draw, assembles the typed payload
// (`buildDischargeSummaryPayload`) and emits `m16.bereavement.document_requested` naming the CLOSURE as the aggregate. M22 renders it
// (`bereavement_discharge_summary_internal`, an internal-only document) and the back-ref stamps `discharge_summary_document_id`.
//
// Callers: the 13-month cron close, `cosignClose` (an early close) and the post-creation patient-opt-out cascade. Not the pre-death patient
// opt-out SKIP: that closes a plan which never had a roster or a schedule, so there is nothing offered or delivered to report.
//
// The selects name columns explicitly (never `select()` on a table), so no sealed column (a contact's channels or care goals, a log row's
// notes) is ever read into this module.
import { type DbClient, schema } from "@chartwarden/db";
import type { BereavementPlanClosureReason } from "@chartwarden/types";
import { BEREAVEMENT_DISCHARGE_SUMMARY_TEMPLATE_KEY } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/write-service";
import { type DischargeSummaryRows, buildDischargeSummaryPayload } from "./discharge-summary";

const CONTACT = schema.bereavedContact;
const OUTREACH = schema.bereavementOutreach;
const TASK = schema.bereavementAssessmentTask;
const OPT_OUT = schema.bereavementOptOut;
const SCORE = schema.bereavementRiskScore;
const LOG = schema.bereavementContactLog;

/** The log outcomes that are an unsuccessful attempt to reach someone (the unreachable detector reads `no_response`; these are all of them). */
const FAILED_ATTEMPT_OUTCOMES = [
  "no_response",
  "voicemail_left",
  "wrong_number",
  "returned_undeliverable",
] as const;

export interface DischargeSummaryClosure {
  readonly id: string;
  readonly reason: BereavementPlanClosureReason;
  readonly closeKind: "auto" | "manual" | "cascade";
  readonly closedAt: Date;
}

export interface DischargeSummaryPlan {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly deathDate: string;
}

/** Read the rows the summary draws (named columns only) for one plan. */
export async function loadDischargeSummaryRows(
  tx: DbClient,
  plan: DischargeSummaryPlan,
  closure: DischargeSummaryClosure,
): Promise<DischargeSummaryRows> {
  const contacts = await tx
    .select({
      id: CONTACT.id,
      relationship: CONTACT.relationshipCode,
      status: CONTACT.status,
      unreachableAt: CONTACT.unreachableAt,
      createdAt: CONTACT.createdAt,
    })
    .from(CONTACT)
    .where(eq(CONTACT.planId, plan.id));
  const outreach = await tx
    .select({
      contactId: OUTREACH.bereavedContactId,
      cadenceMark: OUTREACH.cadenceMark,
      kind: OUTREACH.kind,
      anniversaryMark: OUTREACH.anniversaryMark,
      deathAnchorAt: OUTREACH.deathAnchorAt,
      dueAt: OUTREACH.dueAt,
      status: OUTREACH.status,
      completedAt: OUTREACH.completedAt,
    })
    .from(OUTREACH)
    .where(eq(OUTREACH.planId, plan.id));
  const tasks = await tx
    .select({
      contactId: TASK.bereavedContactId,
      taskKind: TASK.taskKind,
      status: TASK.status,
      dueAt: TASK.dueAt,
      completedAt: TASK.completedAt,
    })
    .from(TASK)
    .where(eq(TASK.planId, plan.id));
  const optOuts = await tx
    .select({
      contactId: OPT_OUT.bereavedContactId,
      optOutKind: OPT_OUT.optOutKind,
      channelKinds: OPT_OUT.channelKinds,
      optedOutAt: OPT_OUT.optedOutAt,
      rescindedAt: OPT_OUT.rescindedAt,
    })
    .from(OPT_OUT)
    .where(eq(OPT_OUT.planId, plan.id));
  const scores = await tx
    .select({
      contactId: SCORE.bereavedContactId,
      assessedAt: SCORE.assessedAt,
      tier: SCORE.ruleTier,
    })
    .from(SCORE)
    .where(eq(SCORE.planId, plan.id));
  const failedAttempts = await tx
    .select({ contactId: LOG.bereavedContactId, contactAt: LOG.contactAt })
    .from(LOG)
    .where(and(eq(LOG.planId, plan.id), inArray(LOG.outcome, [...FAILED_ATTEMPT_OUTCOMES])));

  return {
    deathDate: plan.deathDate,
    closure: { closedAt: closure.closedAt, reason: closure.reason, closeKind: closure.closeKind },
    contacts,
    outreach,
    tasks,
    optOuts: optOuts.map((o) => ({
      ...o,
      channelKinds: Array.isArray(o.channelKinds)
        ? o.channelKinds.filter((k): k is string => typeof k === "string")
        : [],
    })),
    scores,
    failedAttempts,
  };
}

/**
 * Emit the discharge-summary render request for a closure, on the closure's transaction. Call it after the closure row exists and the
 * plan's future outreach was cancelled; the publisher validates the payload against the boot catalog and rolls the closure back with it
 * if the shape is wrong, so a closure never exists without its request.
 */
export async function requestDischargeSummary(
  tx: DbClient,
  outbox: WriteOutboxPort,
  input: { readonly plan: DischargeSummaryPlan; readonly closure: DischargeSummaryClosure },
): Promise<void> {
  const rows = await loadDischargeSummaryRows(tx, input.plan, input.closure);
  await outbox.publish(tx, {
    organizationId: input.plan.organizationId,
    eventName: "m16.bereavement.document_requested",
    aggregateKind: "bereavement_plan_closure",
    aggregateId: input.closure.id,
    payload: {
      planId: input.plan.id,
      patientId: input.plan.patientId,
      documentKind: "discharge_summary",
      aggregateId: input.closure.id,
      templateKey: BEREAVEMENT_DISCHARGE_SUMMARY_TEMPLATE_KEY,
      payloadJsonb: buildDischargeSummaryPayload(rows),
    },
  });
}
