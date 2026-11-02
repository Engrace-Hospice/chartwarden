// M36 ADR-0106 (PROPOSED) - emergency message with a per-recipient acknowledgment (migration 1300). Names match the migration. The emergency
// is written once by the message's author; its 15-minute deadline is set by the database clock (a client value is ignored). Each recipient
// row's only change is `acknowledged_at` NULL -> database clock, by that person (guard triggers). No message text, no names.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageEmergencies = pgTable(
  "message_emergency",
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
    /** created_at + 15 minutes on the database clock; the guard overwrites any client value. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '15 minutes'`),
  },
  (t) => ({
    deadlineAfterCreate: check(
      "message_emergency_deadline_after_create",
      sql`${t.deadlineAt} > ${t.createdAt}`,
    ),
    orgIdUnique: unique("message_emergency_org_id_unique").on(t.organizationId, t.id),
    messageUnique: unique("message_emergency_message_unique").on(t.organizationId, t.messageId),
    messageFk: foreignKey({
      name: "message_emergency_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    byCreator: index("message_emergency_created_by_idx").on(t.createdBy, t.createdAt),
    byCreated: index("message_emergency_created_idx").on(t.organizationId, t.createdAt),
  }),
);

export const messageEmergencyRecipients = pgTable(
  "message_emergency_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    emergencyId: uuid("emergency_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** NULL until the person acknowledges; then the database clock, once, never withdrawn. A late acknowledgment is still recorded. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientUnique: unique("message_emergency_recipient_unique").on(t.emergencyId, t.userId),
    emergencyFk: foreignKey({
      name: "message_emergency_recipient_emergency_fk",
      columns: [t.organizationId, t.emergencyId],
      foreignColumns: [messageEmergencies.organizationId, messageEmergencies.id],
    }).onDelete("cascade"),
    byWaiting: index("message_emergency_recipient_waiting_idx")
      .on(t.organizationId, t.userId)
      .where(sql`${t.acknowledgedAt} IS NULL`),
    byUser: index("message_emergency_recipient_user_fk_idx").on(t.userId),
  }),
);
