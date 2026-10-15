// WP 4.4 (ADR-0070): arms the escalation timer for a request when it is requested, reassigned or escalated. The consumer reads
// the request's CURRENT window from the database (the tenant is the envelope's, the request id the payload's) and adds the
// deterministic delayed job for it, so a stale or replayed event arms exactly the job the database says is next. It never writes
// the request and ignores the escalation flag (arming is safe; the flag gates the action). A throw (Redis unreachable) is
// rethrown so the outbox retries, and the per-minute sweeper covers the request meanwhile.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import {
  M36_ACK_ESCALATED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
} from "../ack-requests/ack-events";

export const M36_ACK_TIMER_ARMING_CONSUMER = "m36.ack-timer-arming" as const;

export function buildM36AckTimerArmingConsumer(deps: {
  readonly armFromRequest: (orgId: string, requestId: string) => Promise<void>;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_ACK_TIMER_ARMING_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_ACK_REQUESTED, M36_ACK_REASSIGNED, M36_ACK_ESCALATED],
    async handle(event: DispatchableOutboxEvent) {
      const requestId = (event.payload as Record<string, unknown> | undefined)?.requestId;
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw new Error(`${M36_ACK_TIMER_ARMING_CONSUMER}: missing requestId`);
      }
      await deps.armFromRequest(event.organizationId, requestId);
    },
  };
}
