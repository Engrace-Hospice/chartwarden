// apps/backend/src/modules/36-messaging/outbox-consumers/schedule-blocked.ts — WP 2.6: tells the SENDER that a scheduled
// message was not sent. The dispatcher publishes `m36.message.schedule_blocked` in the transaction that flips the row to
// `blocked`; this consumer turns it into one in-app alert (platform rule `m36.message.schedule_blocked`, recipient =
// `payload.senderUserId`, in-app only).
//
// Deliberately NOT access-gated like the mention consumer: the sender may have just lost the channel, which is the very
// reason it was blocked, and the alert says nothing about the channel. The text is generic (no channel title, patient
// or message content); the deep link opens the sender's own Scheduled list, which shows the reason.
// TENANT: from the envelope `event.organizationId`, never the payload. A malformed payload THROWS (relay retry -> DLQ).
import {
  type AlertEmitter,
  SCHEDULE_BLOCK_REASONS,
  type ScheduleBlockReason,
  scheduleBlockedMessage,
} from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_SCHEDULE_BLOCKED_CONSUMER = "m36.schedule-blocked" as const;
export const M36_SCHEDULE_BLOCKED_EVENTS = ["m36.message.schedule_blocked"] as const;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_SCHEDULE_BLOCKED_CONSUMER}: missing ${key}`);
  }
  return value;
}

function requireReason(payload: Record<string, unknown>): ScheduleBlockReason {
  const value = requireString(payload, "reason");
  if (!(SCHEDULE_BLOCK_REASONS as readonly string[]).includes(value)) {
    throw new Error(`${M36_SCHEDULE_BLOCKED_CONSUMER}: unknown reason`);
  }
  return value as ScheduleBlockReason;
}

export function buildM36ScheduleBlockedConsumer(deps: {
  readonly alerts: AlertEmitter;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_SCHEDULE_BLOCKED_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_SCHEDULE_BLOCKED_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const scheduledMessageId = requireString(payload, "scheduledMessageId");
      const senderUserId = requireString(payload, "senderUserId");
      const reason = requireReason(payload);
      await deps.alerts.emit(event.organizationId, {
        eventType: "m36.message.schedule_blocked",
        severity: "info",
        correlationId: `schedule-blocked:${scheduledMessageId}`,
        payload: {
          senderUserId,
          message: scheduleBlockedMessage(reason),
          deepLink: "/messaging?scheduled=1",
        },
      });
    },
  };
}
