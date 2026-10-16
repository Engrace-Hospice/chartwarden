// WP 4.5 (ADR-0071): consumes `m36.notification.delivery_failed` and, when EVERY out-of-band route of an acknowledgment-request alert to
// the request's assignee has terminally failed, asks the delivery-failure service to try the next tier now or, failing that, to mark the
// request `failed_unreachable`. Only the alert types that tell an ASSIGNEE about a request count (a reminder to the sender, or the
// supervisor's own alert, failing is not a failed route to the person who owes the response). The in-app floor is an inbox entry, not a
// proof anyone was reached, so it never counts as a live route; a route that is still pending, sent, delivered, held for quiet hours
// or forwarded keeps the request waiting (a later failure event, or the deadline timer, re-evaluates).
// The tenant is the envelope's. A lookup or router ERROR is rethrown so the outbox retries and dead-letters; nothing is dropped on a blip.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { DeliveryFailureService } from "../ack-delivery-failure/delivery-failure-service";
import type { DeliveryRouteReader } from "../ack-delivery-failure/delivery-route-reader-db";
import {
  M36_ACK_ESCALATED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
} from "../ack-requests/ack-events";
import { M36_URGENT_MESSAGE_SENT } from "../urgent/urgent-events";

export const M36_ACK_DELIVERY_FAILURE_CONSUMER = "m36.ack-delivery-failure" as const;
export const M36_DELIVERY_FAILED_EVENT = "m36.notification.delivery_failed" as const;

/** The alerts that tell the ASSIGNEE of a request that it needs them (the primary route). */
export const ACK_ASSIGNEE_ALERT_EVENT_TYPES: ReadonlySet<string> = new Set([
  M36_URGENT_MESSAGE_SENT,
  M36_ACK_REQUESTED,
  M36_ACK_REASSIGNED,
  M36_ACK_ESCALATED,
]);

const IN_APP_FLOOR = "in_app";
const FAILED = "failed";

export function buildM36AckDeliveryFailureConsumer(deps: {
  readonly readRoutes: DeliveryRouteReader;
  readonly service: Pick<DeliveryFailureService, "onAllRoutesFailed">;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_ACK_DELIVERY_FAILURE_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_DELIVERY_FAILED_EVENT],
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const alertEventType = payload.alertEventType;
      // Not about a request: other modules' alerts share this event. Silent by design (M19/M20/M26 own theirs).
      if (
        typeof alertEventType !== "string" ||
        !ACK_ASSIGNEE_ALERT_EVENT_TYPES.has(alertEventType)
      ) {
        return;
      }
      const messageId = payload.sourceAggregateId;
      const deliveryId = payload.notificationId;
      if (typeof deliveryId !== "string" || deliveryId.length === 0) {
        throw new Error(`${M36_ACK_DELIVERY_FAILURE_CONSUMER}: missing notificationId`);
      }
      const skip = (reason: string): void =>
        deps.warn?.("delivery failure not applied to an acknowledgment request", {
          reason,
          organizationId: event.organizationId,
          deliveryId,
        });
      if (typeof messageId !== "string" || messageId.length === 0)
        return skip("alert_has_no_message");
      const state = await deps.readRoutes(event.organizationId, deliveryId);
      if (!state) return skip("delivery_not_found");
      const outOfBand = state.routes.filter((r) => r.channel !== IN_APP_FLOOR);
      if (outOfBand.length === 0 || !outOfBand.every((r) => r.status === FAILED)) {
        return skip("other_routes_still_open");
      }
      const outcome = await deps.service.onAllRoutesFailed(event.organizationId, {
        messageId,
        recipientUserId: state.recipientUserId,
        alertCreatedAt: state.alertCreatedAt,
      });
      if (outcome.kind !== "escalated" && outcome.kind !== "failed_unreachable") {
        skip(outcome.kind);
      }
    },
  };
}
