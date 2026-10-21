// WP 5.8 (ADR-0087, PROPOSED): turns the `m36.break_glass.granted` outbox event into ONE fixed-text in-app alert for the compliance reviewers
// (AlertEmitter seam; rule `m36.break_glass.granted`: the holders of messaging.break_glass.review, the tenant administrators when nobody holds
// it; system_locked, so a tenant may tighten but never disable or re-route it).
//
// The tenant comes from the envelope, never the payload. The alert carries NO name, channel title, patient or reason text: ids, the closed
// reason code and one fixed sentence, with a link to the review queue. DURABILITY: a failed emit makes `handle` throw and the relay redelivers;
// the alert is unique on (organization_id, correlation_id) and the correlation id is derived from the grant id, so a redelivery after a partial
// success can never alert twice. Only `granted` is consumed: `revoked` and `reviewed` are trail-only events (no declared consumer).
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_BREAK_GLASS_EVENTS } from "../break-glass/break-glass-events";

export const M36_BREAK_GLASS_NOTIFICATION_CONSUMER = "m36.break-glass-notifications" as const;
export const M36_BREAK_GLASS_NOTIFICATION_EVENTS = [M36_BREAK_GLASS_EVENTS.granted] as const;

/** Provisional copy (compliance sign-off pending): says what happened, never who, where or why. */
export const BREAK_GLASS_GRANTED_ALERT_TEXT =
  "Someone opened break-glass access to a conversation. Every read is recorded and a review is waiting" as const;
/** Where a reviewer goes: the review queue. */
export const BREAK_GLASS_REVIEW_DEEP_LINK = "/messaging/governance/break-glass" as const;

function requireText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_BREAK_GLASS_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export interface BreakGlassNotificationDeps {
  readonly alerts: AlertEmitter;
}

export function buildM36BreakGlassNotificationsConsumer(
  deps: BreakGlassNotificationDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_BREAK_GLASS_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_BREAK_GLASS_NOTIFICATION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      if (event.eventType !== M36_BREAK_GLASS_EVENTS.granted) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const grantId = requireText(payload, "grantId");
      await deps.alerts.emit(event.organizationId, {
        eventType: M36_BREAK_GLASS_EVENTS.granted,
        severity: "warn",
        correlationId: `break-glass:${grantId}:granted`,
        payload: {
          grantId,
          channelId: requireText(payload, "channelId"),
          granteeUserId: requireText(payload, "granteeUserId"),
          reasonCode: requireText(payload, "reasonCode"),
          expiresAt: requireText(payload, "expiresAt"),
          message: BREAK_GLASS_GRANTED_ALERT_TEXT,
          deepLink: BREAK_GLASS_REVIEW_DEEP_LINK,
        },
      });
    },
  };
}
