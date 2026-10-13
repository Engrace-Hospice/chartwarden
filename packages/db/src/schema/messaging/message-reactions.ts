// M36 WP 2.4 - `message_reaction` (migration 1084). A user's non-clinical reaction to a message: a key from a closed
// palette (packages/types messaging-reactions.ts). NOT a read receipt and NOT an acknowledgement - it shares nothing
// with `message_receipt`. The composite FK ties the row to the message's own (organization, channel), so a reaction
// can never point into another channel or tenant. RLS (FORCE) on organization_id + audit trigger are in the migration.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageReactions = pgTable(
  "message_reaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(), // composite FK below
    messageId: uuid("message_id").notNull(), // composite FK below
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageChannelFk: foreignKey({
      name: "message_reaction_message_channel_fk",
      columns: [t.organizationId, t.channelId, t.messageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    uniquePerUserEmoji: unique("message_reaction_unique").on(
      t.organizationId,
      t.messageId,
      t.userId,
      t.emoji,
    ),
    byChannelMessageIdx: index("message_reaction_channel_message_idx").on(
      t.organizationId,
      t.channelId,
      t.messageId,
    ),
    emojiCheck: check(
      "message_reaction_emoji_check",
      sql`${t.emoji} IN ('heart', 'thanks', 'smile', 'celebrate', 'sad', 'hug')`,
    ),
  }),
);

export type MessageReactionRow = typeof messageReactions.$inferSelect;
export type NewMessageReactionRow = typeof messageReactions.$inferInsert;
