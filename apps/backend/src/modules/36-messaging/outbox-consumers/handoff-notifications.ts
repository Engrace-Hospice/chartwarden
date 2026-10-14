// WP 3.5: turns handoff outbox events into fixed-text, in-app alerts (AlertEmitter seam), like task-notifications.ts.
// The tenant comes from the envelope, never the payload. Every text is PROVISIONAL (clinical-lead sign-off pending) and
// contains no name, patient or item: a handoff alert is an inbox entry, never the emergency path - it pages nobody, and
// the copy says what is NOT promised ("stay with you"). Alert correlation ids carry the event id so a second unaccepted
// event for the same handoff (sender_left, then expired) is not swallowed by the (org, correlation_id) dedupe.
//
//   m36.handoff.offered     -> the receiver, only if the handoff is STILL offered and they are still active
//   m36.handoff.accepted    -> the sender
//   m36.handoff.unaccepted  -> the sender, then the supervisor audience (rule m36.handoff.supervisor_review); when that
//                              reaches nobody, a needs_attention event is appended to the handoff and the sender is told
//                              (m36.handoff.no_supervisor) - the loud fallback, never a silent drop.
import type { AlertEmitter } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_HANDOFF_EVENTS } from "../handoffs/handoff-events";

export const M36_HANDOFF_NOTIFICATION_CONSUMER = "m36.handoff-notifications" as const;
export const M36_HANDOFF_NOTIFICATION_EVENTS = [
  M36_HANDOFF_EVENTS.offered,
  M36_HANDOFF_EVENTS.accepted,
  M36_HANDOFF_EVENTS.unaccepted,
] as const;

/** Alert types that are alert-rule keys only (not outbox catalog events); seeded in PLATFORM_DEFAULT_ALERT_RULES. */
export const HANDOFF_SUPERVISOR_ALERT = "m36.handoff.supervisor_review" as const;
export const HANDOFF_NO_SUPERVISOR_ALERT = "m36.handoff.no_supervisor" as const;

export const HANDOFF_NOTIFICATION_TEXT = {
  offered: "A colleague offered you a handoff",
  accepted: "Your handoff was accepted",
  partlyAccepted: "Part of your handoff was accepted",
  unaccepted: "A handoff you offered was not accepted. The patients stay with you.",
  supervisorReview: "A handoff was not accepted and its patients stay with the sender",
  noSupervisor: "No supervisor could be reached about your unaccepted handoff",
} as const;

const HANDOFFS_DEEP_LINK = "/notifications?tab=handoffs";

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_HANDOFF_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

function countOf(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface HandoffNotificationDeps {
  readonly alerts: AlertEmitter;
  /** Is the handoff still `offered`? A stale `offered` event must not alert. */
  readonly stillOffered: (orgId: string, handoffId: string) => Promise<boolean>;
  /** Record that no supervisor could be reached (idempotent). */
  readonly markNeedsAttention: (orgId: string, handoffId: string) => Promise<void>;
  /** A user who left must not be alerted. */
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
}

export function buildM36HandoffNotificationsConsumer(
  deps: HandoffNotificationDeps,
): OutboxConsumerBinding {
  const notify = (
    event: DispatchableOutboxEvent,
    handoffId: string,
    alertType: string,
    recipientKey: "toUserId" | "fromUserId",
    recipient: string,
    message: string,
    severity: "info" | "warn" = "info",
  ) =>
    deps.alerts.emit(event.organizationId, {
      eventType: alertType,
      severity,
      correlationId: `handoff:${handoffId}:${event.id}:${alertType}`,
      payload: {
        [recipientKey]: recipient,
        handoffId,
        message,
        deepLink: HANDOFFS_DEEP_LINK,
      },
    });

  async function onOffered(event: DispatchableOutboxEvent, p: Record<string, unknown>) {
    const handoffId = requireId(p, "handoffId");
    const toUserId = requireId(p, "toUserId");
    if (!(await deps.stillOffered(event.organizationId, handoffId))) return;
    if (!(await deps.isActiveUser(event.organizationId, toUserId))) return;
    await notify(
      event,
      handoffId,
      event.eventType,
      "toUserId",
      toUserId,
      HANDOFF_NOTIFICATION_TEXT.offered,
    );
  }

  async function onAccepted(event: DispatchableOutboxEvent, p: Record<string, unknown>) {
    const handoffId = requireId(p, "handoffId");
    const fromUserId = requireId(p, "fromUserId");
    if (!(await deps.isActiveUser(event.organizationId, fromUserId))) return;
    const message =
      countOf(p, "pendingItemCount") > 0
        ? HANDOFF_NOTIFICATION_TEXT.partlyAccepted
        : HANDOFF_NOTIFICATION_TEXT.accepted;
    await notify(event, handoffId, event.eventType, "fromUserId", fromUserId, message);
  }

  async function onUnaccepted(event: DispatchableOutboxEvent, p: Record<string, unknown>) {
    const handoffId = requireId(p, "handoffId");
    const fromUserId = requireId(p, "fromUserId");
    const senderActive = await deps.isActiveUser(event.organizationId, fromUserId);
    if (senderActive) {
      await notify(
        event,
        handoffId,
        event.eventType,
        "fromUserId",
        fromUserId,
        HANDOFF_NOTIFICATION_TEXT.unaccepted,
      );
    }
    const supervisors = await notify(
      event,
      handoffId,
      HANDOFF_SUPERVISOR_ALERT,
      "fromUserId",
      fromUserId,
      HANDOFF_NOTIFICATION_TEXT.supervisorReview,
      "warn",
    );
    if (supervisors.resolvedRecipientCount > 0) return;
    await deps.markNeedsAttention(event.organizationId, handoffId);
    if (senderActive) {
      await notify(
        event,
        handoffId,
        HANDOFF_NO_SUPERVISOR_ALERT,
        "fromUserId",
        fromUserId,
        HANDOFF_NOTIFICATION_TEXT.noSupervisor,
      );
    }
  }

  return {
    consumerName: M36_HANDOFF_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_HANDOFF_NOTIFICATION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      switch (event.eventType) {
        case M36_HANDOFF_EVENTS.offered:
          return onOffered(event, payload);
        case M36_HANDOFF_EVENTS.accepted:
          return onAccepted(event, payload);
        case M36_HANDOFF_EVENTS.unaccepted:
          return onUnaccepted(event, payload);
        default:
          return;
      }
    },
  };
}
