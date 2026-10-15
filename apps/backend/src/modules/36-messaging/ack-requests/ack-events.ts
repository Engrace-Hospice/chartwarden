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

export type AckEventName =
  | typeof M36_ACK_REQUESTED
  | typeof M36_ACK_ACKNOWLEDGED
  | typeof M36_ACK_REASSIGNED
  | typeof M36_ACK_RESOLVED
  | typeof M36_ACK_CANCELLED;

export interface AckEventFacts {
  readonly orgId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly ackClass: AckClass;
  readonly assignedUserId: string;
  /** Null never happens in 4.2 (every transition is a user's); WP 4.4 timers will pass null. */
  readonly actorUserId: string | null;
  readonly version: number;
  readonly previousAssignedUserId?: string;
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
