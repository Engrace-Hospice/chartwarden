// ADR-0106: turns `m36.emergency.sent` (one event per frozen recipient) into the FIRST alarm, tick 0, for that recipient (AlertEmitter seam,
// like urgent-notifications.ts). The tenant comes from the envelope, never the payload. The recipient's channel access is re-checked now (a
// stale event must not alarm someone who lost access). A THROW propagates so the outbox retries and dead-letters: a database blip must never
// swallow an emergency alarm. The re-alarm every minute and the deadline escalation are the sweep's (emergency-sweep.ts).
import type { AlertEmitter, MessagingRouteService } from "@chartwarden/messaging";
import { M36_EMERGENCY_SENT } from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { emergencyAlarm } from "../emergency/emergency-alert";

const M36_EMERGENCY_NOTIFICATION_CONSUMER = "m36.emergency-notifications" as const;

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_EMERGENCY_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36EmergencyNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  /** Warn-level, ids and a reason code only - never a name, patient or text. */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_EMERGENCY_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_EMERGENCY_SENT],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const emergencyId = requireId(payload, "emergencyId");
      const messageId = requireId(payload, "messageId");
      const channelId = requireId(payload, "channelId");
      const recipientUserId = requireId(payload, "recipientUserId");
      if (
        !(await deps.messaging.canViewChannel(event.organizationId, recipientUserId, channelId))
      ) {
        deps.warn?.("emergency alarm not delivered", {
          reason: "recipient_cannot_view_channel",
          organizationId: event.organizationId,
          emergencyId,
          recipientUserId,
        });
        return;
      }
      await deps.alerts.emit(
        event.organizationId,
        emergencyAlarm({ emergencyId, channelId, messageId, recipientUserId, tick: 0 }),
      );
    },
  };
}
