// WP 4.4 (ADR-0070): turns the escalation events into generic in-app alerts (AlertEmitter seam), fixed text with no name, patient
// or message text. In-app only: out-of-band delivery is WP 4.6. NOT a page and NOT the emergency path.
//   - `m36.ack.escalated`           the NEW assignee (the tier's clinician) is told it was escalated to them;
//   - `m36.ack.route_unavailable`   the sender and the current assignee are told the deadline passed, nobody else could be
//                                   reached and the request is still open;
//   - `m36.ack.ladder_exhausted`    the same text for the sender and assignee.
// The first record of each unroutable type also raises the SUPERVISOR attention alert (in-app, plus a page to a verified endpoint when the
// notification policy is on - ADR-0079) and an ops notice, so neither type is visible only on the queue and the gauges (G-3, G-4).
// The tenant is the envelope's. Stale-event rule (WP 4.2): at consume time the request must STILL be in the state the event
// announced at the event's version (escalated and assigned to the recipient / still open), else nobody is alerted; a recipient
// who can no longer see the channel (or, for the new assignee, is no longer qualified) is skipped with an id-only warn. A lookup
// ERROR is rethrown so the outbox retries and dead-letters; an alert is never dropped on a blip.
import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import {
  type SupervisorAttentionDeps,
  createOnceGuard,
  raiseSupervisorAttention,
} from "../ack-escalation/supervisor-attention";
import {
  M36_ACK_ESCALATED,
  M36_ACK_LADDER_EXHAUSTED,
  M36_ACK_ROUTE_UNAVAILABLE,
} from "../ack-requests/ack-events";
import type { AckRow } from "../ack-requests/ack-types";

export const M36_ACK_ESCALATION_NOTIFICATION_CONSUMER = "m36.ack-escalation-notifications" as const;

export const ACK_ESCALATION_NOTIFICATION_TEXT = {
  escalated: "A clinical message was escalated to you because it was not acknowledged in time",
  route_unavailable:
    "A clinical message was not acknowledged in time and could not be escalated; it is still open",
  ladder_exhausted:
    "A clinical message was not acknowledged in time and there is no further escalation tier; it is still open",
} as const;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_ACK_ESCALATION_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export const ACK_UNROUTED_OPS_KIND = {
  route_unavailable: "m36.ack.route_unavailable",
  ladder_exhausted: "m36.ack.ladder_exhausted",
} as const;

export function buildM36AckEscalationNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  /** ADR-0079: the ops sink (log line plus OPS_ALERT_WEBHOOK_URL) for the first unroutable record of a request and for an unpaged supervisor alert. */
  readonly opsNotice: SupervisorAttentionDeps["opsNotice"];
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly readRequest: (orgId: string, requestId: string) => Promise<AckRow | null>;
  /** Active, keys, urgent.receive, Part 2 gate (not channel visibility: `messaging.canViewChannel` is asked separately). A clean false is a skip; a throw propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  const firstNotice = createOnceGuard();
  return {
    consumerName: M36_ACK_ESCALATION_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_ACK_ESCALATED, M36_ACK_ROUTE_UNAVAILABLE, M36_ACK_LADDER_EXHAUSTED],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = requireString(payload, "requestId");
      const channelId = requireString(payload, "channelId");
      const messageId = requireString(payload, "messageId");
      const at = requireString(payload, "at");
      const version = payload.requestVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new Error(`${M36_ACK_ESCALATION_NOTIFICATION_CONSUMER}: missing requestVersion`);
      }
      const skip = (reason: string): void =>
        deps.warn?.("escalation notification not delivered", {
          reason,
          eventType: event.eventType,
          organizationId: event.organizationId,
          requestId,
          channelId,
        });
      const row = await deps.readRequest(event.organizationId, requestId);
      if (!row || row.version !== version) return skip("request_changed_since_event");
      const deepLink = `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}`;

      if (event.eventType === M36_ACK_ESCALATED) {
        const assignee = requireString(payload, "assignedUserId");
        if (row.status !== "escalated" || row.assignedUserId !== assignee) {
          return skip("request_not_escalated_to_recipient");
        }
        if (!(await deps.messaging.canViewChannel(event.organizationId, assignee, channelId))) {
          return skip("recipient_cannot_view_channel");
        }
        if (!(await deps.stillQualified(event.organizationId, assignee, channelId))) {
          return skip("recipient_not_qualified");
        }
        await deps.alerts.emit(event.organizationId, {
          eventType: event.eventType,
          severity: "warn",
          // One alert per request, version and assignee: a redelivery converges on the same id.
          correlationId: `ack-esc:${requestId}:${version}:${assignee}`,
          payload: {
            recipientUserId: assignee,
            channelId,
            messageId,
            // The message the alert is ABOUT (read back by `m36.notification.delivery_failed`, WP 4.5).
            sourceAggregateId: messageId,
            // WP 4.6: the class the notification policy takes its platform floor from (a class, not PHI).
            ackClass: row.ackClass,
            message: ACK_ESCALATION_NOTIFICATION_TEXT.escalated,
            deepLink,
          },
        });
        return;
      }

      // Not routed: the request must still be open and waiting, then the sender and the current assignee are told.
      if (row.status !== "pending" && row.status !== "escalated")
        return skip("request_not_waiting");
      const recipients: string[] = [];
      for (const userId of new Set([row.requesterUserId, row.assignedUserId])) {
        if (await deps.messaging.canViewChannel(event.organizationId, userId, channelId)) {
          recipients.push(userId);
        }
      }
      // The parties first: a supervisor-side failure below must not delay or lose their alert (a retry re-emits idempotently).
      if (recipients.length > 0)
        await deps.alerts.emit(event.organizationId, {
          eventType: event.eventType,
          severity: "warn",
          // One alert per recorded event (its own instant): the hourly re-record is a deliberate reminder.
          correlationId: `ack-unrouted:${requestId}:${version}:${event.eventType}:${at}`,
          payload: {
            recipientUserIds: recipients,
            channelId,
            messageId,
            message:
              event.eventType === M36_ACK_LADDER_EXHAUSTED
                ? ACK_ESCALATION_NOTIFICATION_TEXT.ladder_exhausted
                : ACK_ESCALATION_NOTIFICATION_TEXT.route_unavailable,
            deepLink,
          },
        });
      // The supervisors are told on the FIRST record of each unroutable type only; the backoff reminders go to the parties alone.
      const occurrence = typeof payload.typeOccurrence === "number" ? payload.typeOccurrence : 1;
      if (occurrence === 1) {
        const reason =
          event.eventType === M36_ACK_LADDER_EXHAUSTED ? "ladder_exhausted" : "route_unavailable";
        const correlationId = `ack-attn:${requestId}:${version}:${reason}:${at}`;
        // The notice before the alert: a failing alert must not lose it. De-duplicated in-process for a retried handler only.
        if (firstNotice(correlationId)) {
          deps.opsNotice({
            kind: ACK_UNROUTED_OPS_KIND[reason],
            summary:
              reason === "ladder_exhausted"
                ? "An acknowledgment request passed its deadline with no further escalation tier and needs a human"
                : "An acknowledgment request passed its deadline and could not be escalated (no router answer) and needs a human",
            details: { organizationId: event.organizationId, requestId, ackClass: row.ackClass },
            correlationId,
          });
        }
        await raiseSupervisorAttention(deps, event.organizationId, row, reason, correlationId);
      }
      if (recipients.length === 0) skip("no_recipient_can_view_channel");
    },
  };
}
