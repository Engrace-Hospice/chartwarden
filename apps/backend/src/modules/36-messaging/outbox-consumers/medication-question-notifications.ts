// WP 3.10: turns the unrouted medication-question event into ONE fixed-text in-app alert for the supervisor audience (the
// seeded role rule m36.medication_question.unrouted, copied from the 3.5 supervisor rule). The tenant comes from the envelope,
// never the payload. The text is PROVISIONAL (clinical-lead / pharmacy sign-off pending) and carries no name, patient or
// question text: it is an inbox entry, never the emergency path. The correlation id is (channel, asker, 10-minute bucket of the event stamp), so a redelivery AND a burst of
// unrouted asks by one person in one conversation converge on one alert (the emitter absorbs a repeat id); the event itself is still per send. The deep link re-checks access when opened.
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_MEDICATION_QUESTION_UNROUTED } from "../medication-questions/medication-question-events";

export const M36_MEDICATION_QUESTION_NOTIFICATION_CONSUMER =
  "m36.medication-question-notifications" as const;

/** One supervisor alert per (channel, asker) per window: a loop of unrouted asks must not flood the audience. */
export const MEDICATION_QUESTION_ALERT_WINDOW_MS = 10 * 60 * 1000;

export const MEDICATION_QUESTION_NOTIFICATION_TEXT = "A medication question has no assigned nurse";

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_MEDICATION_QUESTION_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

/** Window bucket from the event's own stamp (stable across a redelivery); an unreadable stamp gets no dedupe. */
function dedupeKey(payload: Record<string, unknown>, channelId: string, fallback: string): string {
  const asker = payload.askedByUserId;
  const at = typeof payload.at === "string" ? Date.parse(payload.at) : Number.NaN;
  if (typeof asker !== "string" || asker.length === 0 || Number.isNaN(at)) return fallback;
  return `medication-question:${channelId}:${asker}:${Math.floor(at / MEDICATION_QUESTION_ALERT_WINDOW_MS)}`;
}

export function buildM36MedicationQuestionNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_MEDICATION_QUESTION_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_MEDICATION_QUESTION_UNROUTED],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const channelId = requireId(payload, "channelId");
      const messageId = requireId(payload, "messageId");
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        correlationId: dedupeKey(
          payload,
          channelId,
          `medication-question:${messageId}:${event.id}`,
        ),
        payload: {
          channelId,
          messageId,
          message: MEDICATION_QUESTION_NOTIFICATION_TEXT,
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
