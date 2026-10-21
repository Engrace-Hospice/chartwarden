// WP 4.5 (ADR-0071): turns `m36.ack.failed_unreachable` into (1) ONE generic in-app alert for the supervisor audience (seeded role rule),
// the sender and the assignee - the supervisor work item until the unacknowledged queue (WP 4.9) - and (2) an ops notice (the existing
// org-less platform-ops sink: always-on log line plus the optional OPS_ALERT_WEBHOOK_URL), so a request nobody could be reached for is
// never silent. Fixed text, no name, patient or message text; ids only on the ops notice. In-app only: out-of-band delivery is WP 4.6.
// The wording never says anyone WAS reached: it says the message could not be delivered and nobody is known to have received it.
// Order: the stale check first (a request that is no longer `failed_unreachable` at the event's version, e.g. the assignee acknowledged
// meanwhile, alerts and pages nobody), THEN the ops notice, THEN the alert. The notice is never after the alert (a failing alert must not
// lose it); a retry after a failed alert would repeat it, so it is de-duplicated in-process by correlation id (a restart may repeat it once;
// the webhook sink cannot dedupe). The channel and message come from the stored request, not the payload. A lookup ERROR is rethrown so
// the outbox retries and dead-letters.
// ADR-0079: the supervisor audience is told by the shared supervisor attention alert (in-app, plus a page to a verified endpoint when the
// notification policy is on), not by this rule, and a supervisor alert that reached no out-of-band route raises its own ops notice.
import type { AlertEmitter, MessagingRouteService } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import {
  type SupervisorAttentionDeps,
  type SupervisorOpsNotice,
  raiseSupervisorAttention,
} from "../ack-escalation/supervisor-attention";
import { M36_ACK_FAILED_UNREACHABLE } from "../ack-requests/ack-events";
import type { AckRow } from "../ack-requests/ack-types";

export const M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER =
  "m36.ack-unreachable-notifications" as const;

export const ACK_UNREACHABLE_NOTIFICATION_TEXT =
  "A clinical message could not be delivered to anyone and nobody is known to have received it; it is still open";

export const ACK_UNREACHABLE_OPS_KIND = "m36.ack.failed_unreachable" as const;

/** The notice this consumer raises itself; the sink also receives the supervisor module's. */
export type UnreachableOpsNotice = SupervisorOpsNotice;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

const NOTICED_CAP = 1000;

export function buildM36AckUnreachableNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly readRequest: (orgId: string, requestId: string) => Promise<AckRow | null>;
  readonly opsNotice: SupervisorAttentionDeps["opsNotice"];
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  const noticed = new Set<string>();
  return {
    consumerName: M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_ACK_FAILED_UNREACHABLE],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = requireString(payload, "requestId");
      const ackClass = requireString(payload, "ackClass");
      const version = payload.requestVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new Error(`${M36_ACK_UNREACHABLE_NOTIFICATION_CONSUMER}: missing requestVersion`);
      }
      const correlationId = `ack-unreach:${requestId}:${version}`;
      const row = await deps.readRequest(event.organizationId, requestId);
      if (!row || row.version !== version || row.status !== "failed_unreachable") {
        deps.warn?.("unreachable notification not delivered", {
          reason: "request_changed_since_event",
          organizationId: event.organizationId,
          requestId,
        });
        return;
      }
      if (!noticed.has(correlationId)) {
        deps.opsNotice({
          kind: ACK_UNREACHABLE_OPS_KIND,
          summary: "An acknowledgment request could not be delivered to anyone and needs a human",
          details: { organizationId: event.organizationId, requestId, ackClass },
          correlationId,
        });
        noticed.add(correlationId);
        if (noticed.size > NOTICED_CAP) noticed.delete(noticed.values().next().value as string);
      }
      const recipients: string[] = [];
      for (const userId of new Set([row.requesterUserId, row.assignedUserId])) {
        if (await deps.messaging.canViewChannel(event.organizationId, userId, row.channelId)) {
          recipients.push(userId);
        }
      }
      // The parties' alert only; an empty party list still emits (nothing resolves, nothing is sent) and the supervisors follow below.
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        // One alert per request and version: a redelivery converges on the same id.
        correlationId,
        payload: {
          recipientUserIds: recipients,
          channelId: row.channelId,
          messageId: row.messageId,
          message: ACK_UNREACHABLE_NOTIFICATION_TEXT,
          deepLink: `/messaging?channelId=${encodeURIComponent(row.channelId)}&messageId=${encodeURIComponent(row.messageId)}`,
        },
      });
      await raiseSupervisorAttention(
        { alerts: deps.alerts, opsNotice: deps.opsNotice },
        event.organizationId,
        row,
        "failed_unreachable",
        `ack-attn:${requestId}:${version}:failed_unreachable`,
      );
    },
  };
}
