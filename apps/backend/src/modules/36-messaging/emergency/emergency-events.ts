// apps/backend/src/modules/36-messaging/emergency/emergency-events.ts - ADR-0106: the outbox events of an emergency message. PHI-free by
// construction: ids and one instant - no channel name, no text, no person's name. `m36.emergency.sent` is published ONCE PER RECIPIENT in the
// SAME transaction that froze the audience (so a committed emergency always has its events and a rolled-back one never does), exactly like
// `m36.message.urgent_sent`. The catalog entries live in events-by-m36.ts.
import { M36_EMERGENCY_SENT } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export interface EmergencySentFacts {
  readonly orgId: string;
  readonly emergencyId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorUserId: string;
  readonly recipientUserId: string;
  readonly at: Date;
}

function emergencySentPayload(f: EmergencySentFacts): Record<string, unknown> {
  return {
    organizationId: f.orgId,
    emergencyId: f.emergencyId,
    channelId: f.channelId,
    messageId: f.messageId,
    authorUserId: f.authorUserId,
    recipientUserId: f.recipientUserId,
    at: f.at.toISOString(),
  };
}

export async function publishEmergencySent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: EmergencySentFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_EMERGENCY_SENT,
    organizationId: facts.orgId,
    aggregateKind: "message",
    aggregateId: facts.messageId,
    payload: emergencySentPayload(facts),
  });
}
