// WP 4.1: turns the urgent-sent event into ONE generic in-app alert for the named recipient (AlertEmitter seam, like
// task-notifications.ts). The tenant comes from the envelope, never the payload. The recipient's channel access is
// re-checked now (a stale event must not alert someone who lost access). The text is fixed and PROVISIONAL (clinical-lead
// sign-off pending): no name, no patient, no message text. This is an inbox entry, NOT a page and NOT a request for a
// response: the response request, timers and escalation are WP 4.2 - 4.4. The seeded rule keeps it in-app only.
import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_URGENT_MESSAGE_SENT } from "../urgent/urgent-events";

export const M36_URGENT_NOTIFICATION_CONSUMER = "m36.urgent-notifications" as const;

export const URGENT_NOTIFICATION_TEXT = "You have an urgent clinical message";

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_URGENT_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36UrgentNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_URGENT_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_URGENT_MESSAGE_SENT],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const messageId = requireId(payload, "messageId");
      const channelId = requireId(payload, "channelId");
      const recipientUserId = requireId(payload, "recipientUserId");
      if (
        !(await deps.messaging.canViewChannel(event.organizationId, recipientUserId, channelId))
      ) {
        return;
      }
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        // One alert per message and recipient: a redelivery converges on the same id.
        correlationId: `urgent:${messageId}:${recipientUserId}`,
        payload: {
          recipientUserId,
          channelId,
          messageId,
          message: URGENT_NOTIFICATION_TEXT,
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
