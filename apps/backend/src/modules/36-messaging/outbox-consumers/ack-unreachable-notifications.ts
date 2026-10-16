// WP 4.5 (ADR-0071): turns `m36.ack.failed_unreachable` into (1) ONE generic in-app alert for the supervisor audience (seeded role rule),
// the sender and the assignee - the supervisor work item until the unacknowledged queue (WP 4.9) - and (2) an ops notice (the existing
// org-less platform-ops sink: always-on log line plus the optional OPS_ALERT_WEBHOOK_URL), so a request nobody could be reached for is
// never silent. Fixed text, no name, patient or message text; ids only on the ops notice. In-app only: out-of-band delivery is WP 4.6.
// The wording never says anyone WAS reached: it says the message could not be delivered and nobody is known to have received it.
// The ops notice is raised first and unconditionally (it records that the event happened); the alert is sent only while the request is
// STILL `failed_unreachable` at the event's version (a stale event, e.g. the assignee acknowledged meanwhile, alerts nobody). A lookup
// ERROR is rethrown so the outbox retries and dead-letters.
import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_ACK_FAILED_UNREACHABLE } from "../ack-requests/ack-events";
import type { AckRow } from "../ack-requests/ack-types";

export const M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER =
  "m36.ack-unreachable-notifications" as const;

export const ACK_UNREACHABLE_NOTIFICATION_TEXT =
  "A clinical message could not be delivered to anyone and nobody is known to have received it; it is still open";

export const ACK_UNREACHABLE_OPS_KIND = "m36.ack.failed_unreachable" as const;

/** Shape of `buildPlatformOpsNoticeSink`'s notice, restated so this module does not import bootstrap internals. */
export interface UnreachableOpsNotice {
  readonly kind: typeof ACK_UNREACHABLE_OPS_KIND;
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
  readonly correlationId: string;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36AckUnreachableNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly readRequest: (orgId: string, requestId: string) => Promise<AckRow | null>;
  readonly opsNotice: (notice: UnreachableOpsNotice) => void;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_ACK_FAILED_UNREACHABLE],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = requireString(payload, "requestId");
      const channelId = requireString(payload, "channelId");
      const messageId = requireString(payload, "messageId");
      const ackClass = requireString(payload, "ackClass");
      const version = payload.requestVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new Error(`${M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER}: missing requestVersion`);
      }
      const correlationId = `ack-unreach:${requestId}:${version}`;
      deps.opsNotice({
        kind: ACK_UNREACHABLE_OPS_KIND,
        summary: "An acknowledgment request could not be delivered to anyone and needs a human",
        details: { organizationId: event.organizationId, requestId, ackClass },
        correlationId,
      });
      const row = await deps.readRequest(event.organizationId, requestId);
      if (!row || row.version !== version || row.status !== "failed_unreachable") {
        deps.warn?.("unreachable notification not delivered", {
          reason: "request_changed_since_event",
          organizationId: event.organizationId,
          requestId,
        });
        return;
      }
      const recipients: string[] = [];
      for (const userId of new Set([row.requesterUserId, row.assignedUserId])) {
        if (await deps.messaging.canViewChannel(event.organizationId, userId, channelId)) {
          recipients.push(userId);
        }
      }
      // The supervisor audience comes from the seeded role rule, so an empty party list still alerts them.
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        // One alert per request and version: a redelivery converges on the same id.
        correlationId,
        payload: {
          recipientUserIds: recipients,
          channelId,
          messageId,
          message: ACK_UNREACHABLE_NOTIFICATION_TEXT,
          deepLink: `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`,
        },
      });
    },
  };
}
