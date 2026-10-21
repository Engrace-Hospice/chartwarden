import type { AlertEmitter, MessagingRouteService } from "@chartwarden/messaging";
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

const FALLBACK_SENDER = "A colleague";
const MAX_SENDER_NAME_LENGTH = 80;
const ASCII_CONTROL_LIMIT = 0x20;
const ASCII_DELETE = 0x7f;

/** WP 2.3 (PROVISIONAL wording): the sender's display name is the only variable; no body, channel or patient text. */
export function mentionNotificationText(displayName: string | null | undefined): string {
  const safe = [...(displayName ?? "")]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= ASCII_CONTROL_LIMIT && code !== ASCII_DELETE;
    })
    .join("")
    .trim();
  return `${safe.slice(0, MAX_SENDER_NAME_LENGTH) || FALLBACK_SENDER} mentioned you in a conversation`;
}

export function buildM36MessageMentionConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly actorDisplayName: (orgId: string, userId: string) => Promise<string | null>;
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
          message: mentionNotificationText(
            await deps.actorDisplayName(event.organizationId, actorUserId),
          ),
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
