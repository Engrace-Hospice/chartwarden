// WP 4.4 (ADR-0070): turns the escalation events into generic in-app alerts (AlertEmitter seam), fixed text with no name, patient
// or message text. In-app only: out-of-band delivery is WP 4.6. NOT a page and NOT the emergency path.
//   - `m36.ack.escalated`           the NEW assignee (the tier's clinician) is told it was escalated to them;
//   - `m36.ack.route_unavailable`   the sender and the current assignee are told the deadline passed, nobody else could be
//                                   reached and the request is still open;
//   - `m36.ack.ladder_exhausted`    the same, plus the supervisor audience (seeded role rule), because there is no tier left.
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

export function buildM36AckEscalationNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly readRequest: (orgId: string, requestId: string) => Promise<AckRow | null>;
  /** Active, keys, Part 2 gate, sees the channel. A clean false is a skip; a throw propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
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
      if (recipients.length === 0 && event.eventType !== M36_ACK_LADDER_EXHAUSTED) {
        return skip("no_recipient_can_view_channel");
      }
      // The supervisor audience is told of an exhausted ladder on the FIRST such record only; a later record (the backoff reminders)
      // goes to the parties alone, under the not-routed rule, with the same text.
      const occurrence = typeof payload.typeOccurrence === "number" ? payload.typeOccurrence : 1;
      const alertType =
        event.eventType === M36_ACK_LADDER_EXHAUSTED && occurrence > 1
          ? M36_ACK_ROUTE_UNAVAILABLE
          : event.eventType;
      await deps.alerts.emit(event.organizationId, {
        eventType: alertType,
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
    },
  };
}
