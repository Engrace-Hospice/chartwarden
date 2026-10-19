// WP 4.2 (ADR-0069): turns the acknowledgment-request events into ONE generic in-app alert for the assignee (AlertEmitter seam, like
// urgent-notifications.ts). One alert per request and assignee, never a duplicate of the WP 4.1 alert:
//   - `m36.ack.requested` alerts only for the IMPORTANT class (an urgent message already told its recipient through
//     m36.message.urgent_sent; this consumer stays silent for it);
//   - `m36.ack.reassigned` alerts the NEW assignee, whatever the class.
// The tenant comes from the envelope, never the payload. At consume time the request must STILL be waiting (pending), STILL assigned to the
// recipient and STILL at the event's version (a stale event alerts nobody), the recipient must still see the channel and still be qualified. A clean "no" is a quiet,
// id-only warn-level skip; a lookup ERROR is rethrown so the outbox retries and dead-letters (an alert is never dropped on a blip).
// The text is fixed and PROVISIONAL (clinical-lead sign-off pending): no name, no patient, no message text. This is an inbox entry,
// NOT a page, NOT the emergency path, and it does not time anything (WP 4.3 - 4.5).
import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_ACK_REASSIGNED, M36_ACK_REQUESTED } from "../ack-requests/ack-events";

export const M36_ACK_NOTIFICATION_CONSUMER = "m36.ack-notifications" as const;

export const ACK_NOTIFICATION_TEXT = {
  requested: "You have an important clinical message that needs your response",
  reassigned: "A clinical message was reassigned to you",
} as const;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_ACK_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36AckNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  /** Is the request still waiting (pending), still assigned to this user and still at the event's version? A throw propagates (retry). */
  readonly isWaitingForAssignee: (
    orgId: string,
    requestId: string,
    userId: string,
    version: number,
  ) => Promise<boolean>;
  /** Active, messaging keys, `messaging.urgent.receive`, Part 2 gate. A clean false is a skip; a throw propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Warn-level, ids and a reason code only - never a name, patient or text. */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_ACK_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_ACK_REQUESTED, M36_ACK_REASSIGNED],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = requireString(payload, "requestId");
      const channelId = requireString(payload, "channelId");
      const messageId = requireString(payload, "messageId");
      const assignedUserId = requireString(payload, "assignedUserId");
      const ackClass = requireString(payload, "ackClass");
      const version = payload.requestVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new Error(`${M36_ACK_NOTIFICATION_CONSUMER}: missing requestVersion`);
      }
      // The urgent class was told by the WP 4.1 alert; a second one would be a duplicate for the same request.
      if (event.eventType === M36_ACK_REQUESTED && ackClass !== "important") return;
      const skip = (reason: string): void =>
        deps.warn?.("acknowledgment-request notification not delivered", {
          reason,
          organizationId: event.organizationId,
          requestId,
          channelId,
          assignedUserId,
        });
      if (
        !(await deps.isWaitingForAssignee(event.organizationId, requestId, assignedUserId, version))
      ) {
        return skip("request_not_waiting_for_assignee");
      }
      if (!(await deps.messaging.canViewChannel(event.organizationId, assignedUserId, channelId))) {
        return skip("recipient_cannot_view_channel");
      }
      if (!(await deps.stillQualified(event.organizationId, assignedUserId, channelId))) {
        return skip("recipient_not_qualified");
      }
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        // One alert per request, version and assignee: a redelivery converges on the same id.
        correlationId: `ack:${requestId}:${version}:${assignedUserId}`,
        payload: {
          recipientUserId: assignedUserId,
          channelId,
          messageId,
          // The message the alert is ABOUT (read back by `m36.notification.delivery_failed`, WP 4.5).
          sourceAggregateId: messageId,
          // WP 4.6: the class the notification policy takes its platform floor from (a class, not PHI).
          ackClass,
          message:
            event.eventType === M36_ACK_REQUESTED
              ? ACK_NOTIFICATION_TEXT.requested
              : ACK_NOTIFICATION_TEXT.reassigned,
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
