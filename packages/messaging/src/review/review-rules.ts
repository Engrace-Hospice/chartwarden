// M36 WP 3.8 - the pure lifecycle-review rules (ADR-0065). No I/O: the consumer, the queue and the service call these, so
// the cause mapping, the trigger reference, the close mapping and the allowed actions have one definition.
import { createHash } from "node:crypto";
import type {
  ReviewAction,
  ReviewLifecycleCause,
  ReviewSource,
  ReviewState,
  TaskCloseReason,
} from "@wardenx/types";

export const REVIEW_LIST_DEFAULT = 50;
export const REVIEW_LIST_MAX = 100;
/** Open tasks queued per read batch (a patient with thousands of tasks is queued in several pages). */
export const REVIEW_QUEUE_BATCH = 200;

const CORRELATION_HEX_LENGTH = 32;
const M5_DECEASED_EVENT = "m5.patient.deceased";
const M6_DISCHARGED_EVENT = "m6.admission.discharged";

/**
 * Why the patient left care: an M5 death record is death; an M6 discharge is death, transfer or (any other reason,
 * including revocation and for-cause) discharge. Null for an event this review does not act on.
 */
export function lifecycleCause(
  eventType: string,
  dischargeReason: string | undefined,
): ReviewLifecycleCause | null {
  if (eventType === M5_DECEASED_EVENT) return "death";
  if (eventType !== M6_DISCHARGED_EVENT) return null;
  if (dischargeReason === "death") return "death";
  return dischargeReason === "transfer" ? "transfer" : "discharge";
}

/**
 * The dedupe key of a trigger. Death is keyed by the patient (the M6 discharge and the M5 death record converge on one
 * row per task); a discharge or transfer by the admission (a later readmission and discharge queues again). Null when the
 * needed id is missing.
 */
export function triggerRefFor(
  cause: ReviewLifecycleCause,
  ids: { readonly patientId: string; readonly admissionId?: string | undefined },
): string | null {
  return cause === "death" ? ids.patientId : (ids.admissionId ?? null);
}

/** The task transition a supervisor's close leads to: done for work that was handled, cancelled for the rest. */
export function closeActionForReason(reason: TaskCloseReason): "complete" | "cancel" {
  return reason === "action_taken" || reason === "handled_elsewhere" ? "complete" : "cancel";
}

/** What a viewer may do to a row: nothing once decided, nothing when restricted or when the task is no longer active. */
export function allowedReviewActions(
  item: { readonly state: ReviewState },
  ctx: { readonly restricted: boolean; readonly taskActive: boolean },
): ReviewAction[] {
  if (item.state !== "open" || ctx.restricted || !ctx.taskActive) return [];
  return ["reassign", "close"];
}

/**
 * A PHI-free dedupe key for the alerts of one trigger: a hash, so neither the patient nor the admission id reaches the
 * alert store, stable across redeliveries and across the two death events.
 */
export function reviewCorrelationKey(source: ReviewSource, triggerRef: string): string {
  return createHash("sha256")
    .update(`${source}:${triggerRef}`)
    .digest("hex")
    .slice(0, CORRELATION_HEX_LENGTH);
}
