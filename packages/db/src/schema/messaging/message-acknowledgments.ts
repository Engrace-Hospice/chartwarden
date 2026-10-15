// M36 WP 4.2 - the acknowledgment-request aggregate (ADR-0069): one request per message that asks ONE named, qualified
// clinician to take clinical responsibility, plus its append-only event history. Ids, enums and instants only (no note or
// free text). The CHECK/index/trigger names match migration 1107 (pinned by a test); the state machine, the immutable
// columns and the deadline maximum are enforced by the database, not only by the service.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { messageAckClass, messageAckEventType, messageAckStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageAckRequests = pgTable(
  "message_acknowledgment_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    /** Server-derived from the channel; scrubbed from the audit log. */
    patientId: uuid("patient_id").notNull(),
    ackClass: messageAckClass("ack_class").notNull(),
    status: messageAckStatus("status").notNull().default("pending"),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id),
    assignedUserId: uuid("assigned_user_id")
      .notNull()
      .references(() => users.id),
    /** Never changes, even across a reassign (reporting). */
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Equals requested_at until a reassign restarts the window. */
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    currentTier: integer("current_tier").notNull().default(0),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("message_ack_request_org_id_uq").on(t.organizationId, t.id),
    onePerMessage: unique("message_ack_request_one_per_message").on(t.organizationId, t.messageId),
    messageFk: foreignKey({
      name: "message_ack_request_message_fk",
      columns: [t.organizationId, t.channelId, t.messageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    byMessage: index("message_ack_request_message_idx").on(
      t.organizationId,
      t.channelId,
      t.messageId,
    ),
    byAssignee: index("message_ack_request_assignee_idx").on(
      t.organizationId,
      t.assignedUserId,
      t.status,
      t.deadlineAt,
    ),
    byRequester: index("message_ack_request_requester_idx").on(
      t.organizationId,
      t.requesterUserId,
      t.status,
    ),
    openByDeadline: index("message_ack_request_open_deadline_idx")
      .on(t.organizationId, t.deadlineAt)
      .where(sql`${t.status} IN ('pending', 'escalated', 'failed_unreachable')`),
    parties: check("message_ack_request_parties", sql`${t.assignedUserId} <> ${t.requesterUserId}`),
    window: check(
      "message_ack_request_window",
      sql`${t.deadlineAt} > ${t.windowStartedAt} AND ${t.windowStartedAt} >= ${t.requestedAt} AND ${t.deadlineAt} <= ${t.windowStartedAt} + (CASE ${t.ackClass} WHEN 'important' THEN interval '120 minutes' WHEN 'urgent' THEN interval '30 minutes' WHEN 'critical_symptom' THEN interval '10 minutes' END)`,
    ),
    tier: check(
      "message_ack_request_tier",
      sql`${t.currentTier} >= 0 AND (${t.status} <> 'pending' OR ${t.currentTier} = 0) AND (${t.status} <> 'escalated' OR ${t.currentTier} >= 1)`,
    ),
    version: check("message_ack_request_version", sql`${t.version} >= 0`),
    waitingShape: check(
      "message_ack_request_waiting_shape",
      sql`${t.status} NOT IN ('pending', 'escalated', 'failed_unreachable') OR (${t.acknowledgedAt} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.cancelledAt} IS NULL)`,
    ),
    ackShape: check(
      "message_ack_request_ack_shape",
      sql`(${t.acknowledgedAt} IS NULL) = (${t.acknowledgedByUserId} IS NULL) AND (${t.status} <> 'acknowledged' OR ${t.acknowledgedAt} IS NOT NULL) AND (${t.acknowledgedByUserId} IS NULL OR ${t.acknowledgedByUserId} = ${t.assignedUserId})`,
    ),
    resolvedShape: check(
      "message_ack_request_resolved_shape",
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL) AND (${t.resolvedAt} IS NULL) = (${t.resolvedByUserId} IS NULL) AND (${t.resolvedByUserId} IS NULL OR ${t.resolvedByUserId} = ${t.assignedUserId})`,
    ),
    cancelledShape: check(
      "message_ack_request_cancelled_shape",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`,
    ),
  }),
);

export const messageAckEvents = pgTable(
  "message_acknowledgment_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    eventType: messageAckEventType("event_type").notNull(),
    /** Null for the system actor (WP 4.4 / 4.5 timers). */
    actorUserId: uuid("actor_user_id"),
    actorKind: text("actor_kind").notNull(),
    fromStatus: messageAckStatus("from_status"),
    toStatus: messageAckStatus("to_status"),
    /** The assignee after the event. */
    assignedUserId: uuid("assigned_user_id"),
    previousAssignedUserId: uuid("previous_assigned_user_id"),
    tier: integer("tier").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestFk: foreignKey({
      name: "message_ack_event_request_fk",
      columns: [t.organizationId, t.requestId],
      foreignColumns: [messageAckRequests.organizationId, messageAckRequests.id],
    }).onDelete("cascade"),
    byRequest: index("message_ack_event_request_idx").on(
      t.organizationId,
      t.requestId,
      t.createdAt,
    ),
    actorShape: check(
      "message_ack_event_actor_shape",
      sql`${t.actorKind} IN ('user', 'system') AND ((${t.actorKind} = 'system') = (${t.actorUserId} IS NULL))`,
    ),
    tier: check("message_ack_event_tier", sql`${t.tier} >= 0`),
  }),
);

export type MessageAckRequestRow = typeof messageAckRequests.$inferSelect;
export type NewMessageAckRequestRow = typeof messageAckRequests.$inferInsert;
export type MessageAckEventRow = typeof messageAckEvents.$inferSelect;
export type NewMessageAckEventRow = typeof messageAckEvents.$inferInsert;
