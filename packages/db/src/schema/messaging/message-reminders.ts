// M36 WP 4.10 (ADR-0077) - a user's reminder on one non-urgent message. See migration 1125: owner-strict RLS, a 30-day CHECK and a
// trigger that refuses an urgent message or one with an open acknowledgment request. The sweep deletes the row once it has raised the alert.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageReminders = pgTable(
  "message_reminder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull(),
    messageId: uuid("message_id").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("message_reminder_due_idx").on(t.organizationId, t.remindAt),
    byMessage: index("message_reminder_org_channel_message_idx").on(
      t.organizationId,
      t.channelId,
      t.messageId,
    ),
    byUser: index("message_reminder_user_idx").on(t.userId),
    messageFk: foreignKey({
      name: "message_reminder_message_fk",
      columns: [t.organizationId, t.channelId, t.messageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    onePerMessage: unique("message_reminder_one_per_message").on(
      t.organizationId,
      t.userId,
      t.messageId,
    ),
    bounded: check(
      "message_reminder_bounded",
      sql`${t.remindAt} > ${t.setAt} AND ${t.remindAt} <= ${t.setAt} + interval '30 days'`,
    ),
  }),
);

export type MessageReminder = typeof messageReminders.$inferSelect;
export type NewMessageReminder = typeof messageReminders.$inferInsert;
