import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_MESSAGE_MENTION_CONSUMER = "m36.message-mentions" as const;
export const M36_MESSAGE_MENTION_EVENTS = ["m36.message.mentioned"] as const;

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_MESSAGE_MENTION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36MessageMentionConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_MESSAGE_MENTION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_MESSAGE_MENTION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const channelId = requireId(payload, "channelId");
      const messageId = requireId(payload, "messageId");
      const mentionedUserId = requireId(payload, "mentionedUserId");
      const actorUserId = requireId(payload, "actorUserId");
      if (actorUserId === mentionedUserId) return;

      // Membership/clinical access may have changed after commit but before relay delivery.
      // A stale reference remains part of the clinical record, but must never create an alert.
      if (
        !(await deps.messaging.canViewChannel(event.organizationId, mentionedUserId, channelId))
      ) {
        return;
      }
      await deps.alerts.emit(event.organizationId, {
        eventType: "m36.message.mentioned",
        severity: "info",
        correlationId: `message-mention:${messageId}:${mentionedUserId}`,
        payload: {
          mentionedUserId,
          channelId,
          messageId,
          message: "You were mentioned in a secure conversation.",
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
