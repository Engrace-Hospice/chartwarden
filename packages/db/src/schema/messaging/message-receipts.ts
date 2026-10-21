// @chartwarden/db — `message_receipt` (M36 Secure Messaging §3.4). Per-recipient delivered/read
// state for a message (delivered = fanned out server-side, read = explicitly read; never an acknowledgement,
// ADR-0056 item 1; migration 1079 CHECK-blocks the retired `ack` status and `acked_at`).
// M36-F04 / ADR-0010: organization_id is carried DIRECTLY (canonical app.org_id RLS + the SD-028
// composite index); co-partitioned with `message` in M36-T03. The
// unread-inbox query path is served by the partial index on (user_id, status) WHERE
// status = 'delivered'. RLS + the M4 write-audit trigger land in M36-T03.
import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { messageReceiptStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageReceipts = pgTable(
  "message_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(), // composite FK (organization_id, message_id) below
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: messageReceiptStatus("status")
      .$type<"delivered" | "read">()
      .notNull()
      .default("delivered"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** RETIRED (WP 1.6): always NULL, enforced by the 1079 CHECK. Column kept; dropped in a later cleanup. */
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (t) => ({
    messageOrgFk: foreignKey({
      name: "message_receipt_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    byOrgMessageIdx: index("message_receipt_org_message_idx").on(t.organizationId, t.messageId),
    uniquePerMessageUser: uniqueIndex("message_receipt_unique").on(t.messageId, t.userId),
    byUserReadIdx: index("message_receipt_user_read_idx")
      .on(t.userId, t.status)
      .where(sql`status = 'delivered'`), // unread inbox query path
    byMessage: index("message_receipt_message_idx").on(t.messageId),
  }),
);

export type MessageReceipt = typeof messageReceipts.$inferSelect;
export type NewMessageReceipt = typeof messageReceipts.$inferInsert;
