// apps/backend/src/modules/36-messaging/announcement-receipts.ts — M36 WP 2.9: read receipts for announcements.
//
// The announcement channel is org-wide and has NO channel_member rows, so the send path (which fans a `delivered`
// receipt out to each member) writes none for it, and the member-scoped `delivered -> read` flip in markMessagesRead
// finds nothing. A read of an announcement therefore creates the reader's `read` receipt directly. One row per
// (message, reader) by the `message_receipt_unique` index; the author never gets a receipt for their own message;
// a repeat read changes nothing (the original `read_at` stands). A receipt only ever means "read", never a clinical
// confirmation (ADR-0056 item 1).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

/** A Drizzle transaction handle (declared here: messaging-write-core imports this file). */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const MR = schema.messageReceipts;
const MSG = schema.messages;

export async function recordAnnouncementReads(
  tx: Tx,
  args: { orgId: string; userId: string; messageIds: readonly string[] },
): Promise<void> {
  if (args.messageIds.length === 0) return;
  const readable = (await tx
    .select({ id: MSG.id })
    .from(MSG)
    .where(
      and(
        eq(MSG.organizationId, args.orgId),
        inArray(MSG.id, [...args.messageIds]),
        isNull(MSG.deletedAt),
        or(isNull(MSG.authorUserId), ne(MSG.authorUserId, args.userId)),
      ),
    )) as Array<{ id: string }>;
  if (readable.length === 0) return;
  await tx
    .insert(MR)
    .values(
      readable.map((message) => ({
        organizationId: args.orgId,
        messageId: message.id,
        userId: args.userId,
        status: "read" as const,
        readAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [MR.messageId, MR.userId],
      set: { status: "read", readAt: new Date() },
      setWhere: eq(MR.status, "delivered"),
    });
}
