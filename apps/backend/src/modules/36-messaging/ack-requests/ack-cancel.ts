import type { HintOutboxPort } from "../message-hint-events";
// apps/backend/src/modules/36-messaging/ack-requests/ack-cancel.ts - WP 4.2: withdraw the open request of a message that is being
// deleted. Plain SQL over the caller's transaction (no service, flag or seam), so EVERY delete path cancels the request in the
// same transaction as the tombstone - a flag that is off, or a wiring that forgot the service, cannot strand a request on a
// deleted message. The database also refuses to tombstone a message while its request is open (migration 1107), so a path
// that forgets to call this fails loudly instead of leaving an orphan. Deleting never "closes the loop": the request ends
// `cancelled`, with an event naming who deleted the message.
import type { Tx } from "../messaging-write-core";
import { M36_ACK_CANCELLED, publishAckEvent } from "./ack-events";
import { ackTxOver } from "./ack-store-db";

const OPEN = new Set(["pending", "acknowledged", "escalated", "failed_unreachable"]);

/** Returns true when an open request was cancelled. */
export async function cancelOpenRequestForMessage(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly messageId: string;
    readonly actorUserId: string;
    readonly outbox: HintOutboxPort | undefined;
    readonly at?: Date;
  },
): Promise<boolean> {
  const store = ackTxOver(tx, args.orgId);
  const row = await store.findByMessage(args.messageId, true);
  if (!row || !OPEN.has(row.status)) return false;
  const at = args.at ?? new Date();
  const next = await store.update(row.id, row.version, {
    status: "cancelled",
    cancelledAt: at,
    updatedAt: at,
  });
  await store.insertEvent({
    organizationId: next.organizationId,
    requestId: next.id,
    eventType: "cancelled",
    actorUserId: args.actorUserId,
    fromStatus: row.status,
    toStatus: "cancelled",
    assignedUserId: next.assignedUserId,
    previousAssignedUserId: null,
    tier: next.currentTier,
    at,
  });
  await publishAckEvent(args.outbox, tx, M36_ACK_CANCELLED, {
    orgId: next.organizationId,
    requestId: next.id,
    messageId: next.messageId,
    channelId: next.channelId,
    ackClass: next.ackClass,
    assignedUserId: next.assignedUserId,
    actorUserId: args.actorUserId,
    version: next.version,
    at,
  });
  return true;
}
