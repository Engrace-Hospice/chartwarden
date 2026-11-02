// M36 ADR-0107 (PROPOSED) - the people a group tag (@role, @care-team, @on-call) resolved to at send (migration 1302). Insert-only, written in the sending
// transaction; ids and instants only. The application writes only active channel members.
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

export const messageGroupTagRecipients = pgTable(
  "message_group_tag_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    tagKind: text("tag_kind").notNull(),
    tagEntityId: uuid("tag_entity_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientUnique: unique("message_group_tag_recipient_unique").on(
      t.organizationId,
      t.messageId,
      t.tagKind,
      t.tagEntityId,
      t.userId,
    ),
    kindShape: check(
      "message_group_tag_recipient_kind_shape",
      sql`${t.tagKind} IN ('role', 'team', 'on_call')`,
    ),
    messageFk: foreignKey({
      name: "message_group_tag_recipient_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    byMessage: index("message_group_tag_recipient_message_idx").on(t.organizationId, t.messageId),
    byUser: index("message_group_tag_recipient_user_idx").on(t.userId),
  }),
);
