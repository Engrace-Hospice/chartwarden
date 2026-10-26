import { sql } from "drizzle-orm";
// M36 WP 2.6 — scheduled send: a private, sealed message-to-be, sent by the `messaging.scheduled_send` dispatcher at
// `scheduledFor` after it re-checks that the sender may still send it. See migration 1087.
// `bodyCipher` is the tenant-DEK envelope of the plain-text body; never audited, never logged.
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";
import { messages } from "./messages";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const scheduledMessages = pgTable(
  "scheduled_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentMessageId: uuid("parent_message_id"),
    bodyCipher: bytea("body_cipher").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    status: text("status").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    clientMessageId: uuid("client_message_id"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("scheduled_message_due_idx")
      .on(t.organizationId, t.scheduledFor)
      .where(sql`${t.status} = 'pending'`),
    byChannelParent: index("scheduled_message_org_channel_parent_idx").on(
      t.organizationId,
      t.channelId,
      t.parentMessageId,
    ),
    byUser: index("scheduled_message_user_idx").on(t.userId),
    clientMessageUnique: unique("scheduled_message_client_message_unique").on(
      t.organizationId,
      t.userId,
      t.clientMessageId,
    ),
    channelOrgFk: foreignKey({
      name: "scheduled_message_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    parentOrgChannelFk: foreignKey({
      name: "scheduled_message_parent_org_channel_fk",
      columns: [t.organizationId, t.channelId, t.parentMessageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    statusValid: check(
      "scheduled_message_status_valid",
      sql`${t.status} IN ('pending', 'blocked')`,
    ),
    blockedReasonValid: check(
      "scheduled_message_blocked_reason_valid",
      sql`${t.blockedReason} IS NULL OR ${t.blockedReason} IN ('channel_archived', 'not_member', 'permission_revoked', 'announcement_not_permitted', 'parent_unavailable', 'dispatch_failed')`,
    ),
    blockedHasReason: check(
      "scheduled_message_blocked_has_reason",
      sql`(${t.status} = 'blocked') = (${t.blockedReason} IS NOT NULL)`,
    ),
    attemptsNonNeg: check("scheduled_message_attempts_nonneg", sql`${t.attempts} >= 0`),
    timeZoneShape: check(
      "scheduled_message_time_zone_shape",
      sql`char_length(${t.timeZone}) BETWEEN 1 AND 64`,
    ),
  }),
);

export type ScheduledMessage = typeof scheduledMessages.$inferSelect;
export type NewScheduledMessage = typeof scheduledMessages.$inferInsert;
