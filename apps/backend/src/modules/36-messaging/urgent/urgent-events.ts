// apps/backend/src/modules/36-messaging/urgent/urgent-events.ts - WP 4.1: the one outbox event an urgent clinical message
// emits. PHI-free by construction: ids and one instant - no patient id, no text, no name. Published in the SAME transaction
// as the message (the send core's `inTransaction` hook), so a committed urgent message always has its event and a
// rolled-back one never does; an idempotent replay publishes nothing. The catalog entry lives in events-by-m36.ts.
import type { HintOutboxPort } from "../message-hint-events";

export const M36_URGENT_MESSAGE_SENT = "m36.message.urgent_sent";

export interface UrgentSentFacts {
  readonly orgId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorUserId: string;
  readonly recipientUserId: string;
  readonly at: Date;
}

export function urgentSentPayload(f: UrgentSentFacts): Record<string, unknown> {
  return {
    organizationId: f.orgId,
    channelId: f.channelId,
    messageId: f.messageId,
    authorUserId: f.authorUserId,
    recipientUserId: f.recipientUserId,
    at: f.at.toISOString(),
  };
}

export async function publishUrgentSent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: UrgentSentFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_URGENT_MESSAGE_SENT,
    organizationId: facts.orgId,
    aggregateKind: "message",
    aggregateId: facts.messageId,
    payload: urgentSentPayload(facts),
  });
}
