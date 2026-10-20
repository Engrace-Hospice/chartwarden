// M36 WP 4.10 (ADR-0077) - a user's bounded pause of out-of-band notices for the non-urgent alerts of one conversation. See migration
// 1125: owner-strict RLS, a 24-hour CHECK and a trigger that refuses a conversation with an open acknowledgment request.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";

export const messageSnoozes = pgTable(
  "message_snooze",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull(),
    snoozedAt: timestamp("snoozed_at", { withTimezone: true }).notNull().defaultNow(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byChannel: index("message_snooze_org_channel_idx").on(t.organizationId, t.channelId),
    byUser: index("message_snooze_user_idx").on(t.userId),
    channelOrgFk: foreignKey({
      name: "message_snooze_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    onePerChannel: unique("message_snooze_one_per_channel").on(
      t.organizationId,
      t.userId,
      t.channelId,
    ),
    bounded: check(
      "message_snooze_bounded",
      sql`${t.snoozedUntil} > ${t.snoozedAt} AND ${t.snoozedUntil} <= ${t.snoozedAt} + interval '24 hours'`,
    ),
  }),
);

export type MessageSnooze = typeof messageSnoozes.$inferSelect;
export type NewMessageSnooze = typeof messageSnoozes.$inferInsert;
