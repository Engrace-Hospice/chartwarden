// M36 WP 2.4 - `message_pin` (migration 1084). A channel's pinned messages: one row per pinned message, who pinned it
// and when. Pin/unpin is audited by the table's write-audit trigger (the actor is the session user). The composite FK
// ties the pin to the message's own (organization, channel).
import { foreignKey, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messagePins = pgTable(
  "message_pin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(), // composite FK below
    messageId: uuid("message_id").notNull(), // composite FK below
    pinnedByUserId: uuid("pinned_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageChannelFk: foreignKey({
      name: "message_pin_message_channel_fk",
      columns: [t.organizationId, t.channelId, t.messageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    onePinPerMessage: unique("message_pin_unique").on(t.organizationId, t.channelId, t.messageId),
  }),
);

export type MessagePinRow = typeof messagePins.$inferSelect;
export type NewMessagePinRow = typeof messagePins.$inferInsert;
