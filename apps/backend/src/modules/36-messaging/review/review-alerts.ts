// apps/backend/src/modules/36-messaging/review/review-alerts.ts - WP 3.8: the fixed-text, in-app alerts that tell people a
// review item was queued. Shared by the lifecycle consumer (WP 3.8) and the care-team-change consumer (WP 3.9) so neither
// duplicates the dedupe key or the wording. PHI-free by construction: no patient, name, cause word or reason in the text,
// the payload or the correlation id (a hash of source + trigger, never the raw id). Every text is PROVISIONAL (no
// clinical-lead sign-off); the alert never pages anyone - it is an inbox entry.
import { type AlertEmitter, reviewCorrelationKey } from "@wardenx/messaging";
import type { ReviewSource } from "@wardenx/types";

/** Alert types that are alert-rule keys only (not outbox catalog events); seeded in PLATFORM_DEFAULT_ALERT_RULES (S2). */
export const REVIEW_QUEUED_ALERT = "m36.review.queued" as const;
export const REVIEW_TASK_NEEDS_DECISION_ALERT = "m36.review.task_needs_decision" as const;

export const REVIEW_ALERT_TEXT = {
  queued: "Messaging tasks are waiting for a supervisor decision",
  taskNeedsDecision:
    "A patient linked to one of your messaging tasks has left hospice care. Close the task with a reason or a supervisor will reassign it.",
} as const;

export const REVIEW_SUPERVISOR_DEEP_LINK = "/notifications?tab=review";
export const REVIEW_ASSIGNEE_DEEP_LINK = "/notifications?tab=tasks";

export type ReviewWarn = (message: string, context: Record<string, string>) => void;

export interface ReviewAlertDeps {
  readonly alerts: AlertEmitter;
  readonly warn?: ReviewWarn | undefined;
}

export interface ReviewTrigger {
  readonly source: ReviewSource;
  readonly triggerRef: string;
}

/**
 * Tell the supervisor audience that items were queued. The correlation id dedupes redeliveries and the two death events.
 * Returns how many recipients the rule resolved; zero is logged (hash only) and the assignee alert remains the fallback.
 */
export async function emitReviewQueuedAlert(
  deps: ReviewAlertDeps,
  orgId: string,
  trigger: ReviewTrigger,
): Promise<{ resolvedRecipientCount: number }> {
  const key = reviewCorrelationKey(trigger.source, trigger.triggerRef);
  const { resolvedRecipientCount } = await deps.alerts.emit(orgId, {
    eventType: REVIEW_QUEUED_ALERT,
    severity: "warn",
    correlationId: `review:${key}:${REVIEW_QUEUED_ALERT}`,
    payload: { message: REVIEW_ALERT_TEXT.queued, deepLink: REVIEW_SUPERVISOR_DEEP_LINK },
  });
  if (resolvedRecipientCount === 0) {
    deps.warn?.("review queued: no supervisor resolved", { reviewKey: key });
  }
  return { resolvedRecipientCount };
}

/** Tell each affected assignee their task needs a decision (always-on fallback to the supervisor alert). */
export async function emitTaskNeedsDecisionAlerts(
  deps: ReviewAlertDeps,
  orgId: string,
  trigger: ReviewTrigger,
  assigneeUserIds: readonly string[],
): Promise<void> {
  const key = reviewCorrelationKey(trigger.source, trigger.triggerRef);
  for (const userId of new Set(assigneeUserIds)) {
    await deps.alerts.emit(orgId, {
      eventType: REVIEW_TASK_NEEDS_DECISION_ALERT,
      severity: "info",
      correlationId: `review:${key}:${REVIEW_TASK_NEEDS_DECISION_ALERT}:${userId}`,
      payload: {
        assigneeUserId: userId,
        message: REVIEW_ALERT_TEXT.taskNeedsDecision,
        deepLink: REVIEW_ASSIGNEE_DEEP_LINK,
      },
    });
  }
}
