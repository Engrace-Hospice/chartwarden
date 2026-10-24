// M36 WP 6.8 (ADR-0097, PROPOSED) - acknowledge-required broadcast (migration 1200). Names match the migration (pinned by a test). The
// broadcast is written once by the announcement's author; each recipient row's only change is `acknowledged_at` NULL -> database clock, by
// that person (guard triggers). No message text, no names.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageAckBroadcasts = pgTable(
  "message_ack_broadcast",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    /** Derived from the message by the guard; the client value is ignored. */
    channelId: uuid("channel_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Migration 1202: display only (no reminder, no escalation). Set once at creation, in the future by the database clock. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** Migration 1202: the author stops asking. NULL -> database clock, once, by the creator, never undone. */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => ({
    deadlineAfterCreate: check(
      "message_ack_broadcast_deadline_after_create",
      sql`${t.deadlineAt} IS NULL OR ${t.deadlineAt} > ${t.createdAt}`,
    ),
    withdrawnAfterCreate: check(
      "message_ack_broadcast_withdrawn_after_create",
      sql`${t.withdrawnAt} IS NULL OR ${t.withdrawnAt} >= ${t.createdAt}`,
    ),
    orgIdUnique: unique("message_ack_broadcast_org_id_unique").on(t.organizationId, t.id),
    messageUnique: unique("message_ack_broadcast_message_unique").on(t.organizationId, t.messageId),
    messageFk: foreignKey({
      name: "message_ack_broadcast_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    byCreator: index("message_ack_broadcast_created_by_idx").on(t.createdBy, t.createdAt),
    byCreated: index("message_ack_broadcast_created_idx").on(t.organizationId, t.createdAt),
  }),
);

export const messageAckBroadcastRecipients = pgTable(
  "message_ack_broadcast_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    broadcastId: uuid("broadcast_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** NULL until the person acknowledges; then the database clock, once, never withdrawn. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientUnique: unique("message_ack_broadcast_recipient_unique").on(t.broadcastId, t.userId),
    broadcastFk: foreignKey({
      name: "message_ack_broadcast_recipient_broadcast_fk",
      columns: [t.organizationId, t.broadcastId],
      foreignColumns: [messageAckBroadcasts.organizationId, messageAckBroadcasts.id],
    }).onDelete("cascade"),
    byWaiting: index("message_ack_broadcast_recipient_user_idx")
      .on(t.organizationId, t.userId)
      .where(sql`${t.acknowledgedAt} IS NULL`),
    byUser: index("message_ack_broadcast_recipient_user_fk_idx").on(t.userId),
  }),
);
