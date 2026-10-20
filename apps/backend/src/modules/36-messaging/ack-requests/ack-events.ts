// apps/backend/src/modules/36-messaging/ack-requests/ack-events.ts - WP 4.2: the outbox events of the acknowledgment-request
// lifecycle. PHI-free by construction: ids, an enum and one instant - no patient id, no text, no name. Published in the SAME
// transaction as the transition, so a committed transition always has its event and a rolled-back one never does; an
// idempotent repeat publishes nothing. The catalog entries live in events-by-m36.ts.
import type { AckClass } from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_ACK_REQUESTED = "m36.ack.requested";
export const M36_ACK_ACKNOWLEDGED = "m36.ack.acknowledged";
export const M36_ACK_REASSIGNED = "m36.ack.reassigned";
export const M36_ACK_RESOLVED = "m36.ack.resolved";
export const M36_ACK_CANCELLED = "m36.ack.cancelled";
// WP 4.4 (ADR-0070): written by the escalation timer, never by a person.
export const M36_ACK_ESCALATED = "m36.ack.escalated";
export const M36_ACK_ROUTE_UNAVAILABLE = "m36.ack.route_unavailable";
export const M36_ACK_LADDER_EXHAUSTED = "m36.ack.ladder_exhausted";
// WP 4.5 (ADR-0071): written by the delivery-failure handler, never by a person.
export const M36_ACK_FAILED_UNREACHABLE = "m36.ack.failed_unreachable";

export type AckEventName =
  | typeof M36_ACK_REQUESTED
  | typeof M36_ACK_ACKNOWLEDGED
  | typeof M36_ACK_REASSIGNED
  | typeof M36_ACK_RESOLVED
  | typeof M36_ACK_CANCELLED
  | typeof M36_ACK_ESCALATED
  | typeof M36_ACK_ROUTE_UNAVAILABLE
  | typeof M36_ACK_LADDER_EXHAUSTED
  | typeof M36_ACK_FAILED_UNREACHABLE;

export interface AckEventFacts {
  readonly orgId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly ackClass: AckClass;
  readonly assignedUserId: string;
  /** Null for the timer's own events (WP 4.4: escalated, route_unavailable, ladder_exhausted); a user's id otherwise. */
  readonly actorUserId: string | null;
  readonly version: number;
  readonly previousAssignedUserId?: string;
  /** ADR-0078 (`reassigned` only): a SUPERVISOR moved it. The notification consumer then also tells the previous assignee and the sender. */
  readonly supervisorReassign?: boolean;
  /** ADR-0078 (supervisor `reassigned` only): the sender, so the consumer can tell them without a second read. An id, never a name. */
  readonly requesterUserId?: string;
  /** WP 4.4: the router tier the request was escalated to, or the tier that could not be reached. */
  readonly tier?: number;
  /** WP 4.4 (`route_unavailable` / `ladder_exhausted`): which such record this is for the request's current window (1-based). */
  readonly occurrence?: number;
  /** WP 4.4: which record of THIS event type this is for the window (1-based); the supervisor audience is told on the first `ladder_exhausted` only. */
  readonly typeOccurrence?: number;
  /** WP 4.4 (`escalated` only): the deadline of the window the escalation started. */
  readonly deadlineAt?: Date;
  readonly at: Date;
}

export function ackEventPayload(f: AckEventFacts): Record<string, unknown> {
  return {
    organizationId: f.orgId,
    requestId: f.requestId,
    messageId: f.messageId,
    channelId: f.channelId,
    ackClass: f.ackClass,
    assignedUserId: f.assignedUserId,
    actorUserId: f.actorUserId,
    requestVersion: f.version,
    at: f.at.toISOString(),
    ...(f.previousAssignedUserId ? { previousAssignedUserId: f.previousAssignedUserId } : {}),
    ...(f.supervisorReassign ? { supervisorReassign: true } : {}),
    ...(f.requesterUserId ? { requesterUserId: f.requesterUserId } : {}),
    ...(f.tier !== undefined ? { tier: f.tier } : {}),
    ...(f.occurrence !== undefined ? { occurrence: f.occurrence } : {}),
    ...(f.typeOccurrence !== undefined ? { typeOccurrence: f.typeOccurrence } : {}),
    ...(f.deadlineAt ? { deadlineAt: f.deadlineAt.toISOString() } : {}),
  };
}

export async function publishAckEvent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  name: AckEventName,
  facts: AckEventFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: name,
    organizationId: facts.orgId,
    aggregateKind: "message_acknowledgment_request",
    aggregateId: facts.requestId,
    payload: ackEventPayload(facts),
  });
}
