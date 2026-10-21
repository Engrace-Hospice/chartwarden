// apps/backend/src/modules/36-messaging/handoffs/handoff-events.ts - WP 3.5: the transactional outbox events a handoff
// write emits. PHI-free by construction: ids, enums, counts and instants only - never a patient id, an item reference or
// any text. Published in the SAME transaction as the write (the caller passes its `tx`), so an event never announces a
// write that rolled back. An idempotent replay changes nothing and therefore publishes nothing. The catalog entries live
// in events-by-m36.ts (added with the consumer).
import type { HandoffUnacceptedCause } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_HANDOFF_EVENTS = {
  offered: "m36.handoff.offered",
  accepted: "m36.handoff.accepted",
  unaccepted: "m36.handoff.unaccepted",
} as const;

export const HANDOFF_AGGREGATE_KIND = "clinical_handoff";

export type HandoffEventFacts =
  | {
      readonly kind: "offered";
      readonly orgId: string;
      readonly handoffId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly itemCount: number;
      readonly expiresAt: Date;
      readonly at: Date;
    }
  | {
      readonly kind: "accepted";
      readonly orgId: string;
      readonly handoffId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly acceptedItemCount: number;
      readonly pendingItemCount: number;
      readonly at: Date;
    }
  | {
      readonly kind: "unaccepted";
      readonly orgId: string;
      readonly handoffId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly cause: HandoffUnacceptedCause;
      readonly unacceptedItemCount: number;
      readonly acceptedItemCount: number;
      readonly at: Date;
    };

/** The event payload: everything but `kind`, instants as ISO strings, `organizationId` named as the catalog expects. */
export function handoffEventPayload(facts: HandoffEventFacts): Record<string, unknown> {
  const { kind: _kind, orgId, ...rest } = facts;
  const entries = Object.entries(rest).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]);
  return { organizationId: orgId, ...Object.fromEntries(entries) };
}

export async function publishHandoffEvent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: HandoffEventFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_HANDOFF_EVENTS[facts.kind],
    organizationId: facts.orgId,
    aggregateKind: HANDOFF_AGGREGATE_KIND,
    aggregateId: facts.handoffId,
    payload: handoffEventPayload(facts),
  });
}
