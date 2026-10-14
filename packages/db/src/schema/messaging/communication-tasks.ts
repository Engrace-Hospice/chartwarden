// M36 WP 3.4 - communication tasks: a thin row pointing at ONE message, plus its append-only event history. Ids, enums
// and instants only (no title, excerpt or free text). The CHECK/index names match migration 1100 (pinned by a test).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { messages } from "./messages";

export const communicationTasks = pgTable(
  "communication_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    /** Denormalised from the message at create (immutable) so list and visibility checks need no join. */
    channelId: uuid("channel_id").notNull(),
    /** Server-derived from the channel (care_team / bereavement subject), never from the client. */
    patientId: uuid("patient_id"),
    createdBy: uuid("created_by").notNull(),
    assigneeId: uuid("assignee_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    clinicalConcern: boolean("clinical_concern").notNull().default(false),
    closedReason: text("closed_reason"),
    needsOwner: boolean("needs_owner").notNull().default(false),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("communication_task_org_id_uq").on(t.organizationId, t.id),
    messageOrgFk: foreignKey({
      name: "communication_task_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    activePerAssignee: uniqueIndex("communication_task_active_per_assignee")
      .on(t.organizationId, t.messageId, t.assigneeId)
      .where(sql`${t.status} IN ('open', 'accepted')`),
    byAssignee: index("communication_task_assignee_idx").on(
      t.organizationId,
      t.assigneeId,
      t.status,
      t.dueAt,
    ),
    byCreator: index("communication_task_creator_idx").on(t.organizationId, t.createdBy, t.status),
    byPatient: index("communication_task_patient_idx")
      .on(t.organizationId, t.patientId)
      .where(sql`${t.patientId} IS NOT NULL`),
    statusShape: check(
      "communication_task_status_shape",
      sql`${t.status} IN ('open', 'accepted', 'done', 'cancelled')`,
    ),
    reasonShape: check(
      "communication_task_reason_shape",
      sql`${t.closedReason} IS NULL OR ${t.closedReason} IN ('action_taken', 'handled_elsewhere', 'no_action_needed', 'unable_to_complete', 'duplicate')`,
    ),
    reasonOnlyWhenClosed: check(
      "communication_task_reason_only_when_closed",
      sql`${t.closedReason} IS NULL OR ${t.status} IN ('done', 'cancelled')`,
    ),
    clinicalCloseNeedsReason: check(
      "communication_task_clinical_close_needs_reason",
      sql`NOT (${t.clinicalConcern} AND ${t.status} IN ('done', 'cancelled')) OR ${t.closedReason} IS NOT NULL`,
    ),
    patientIsClinical: check(
      "communication_task_patient_is_clinical",
      sql`${t.patientId} IS NULL OR ${t.clinicalConcern}`,
    ),
    closedAtShape: check(
      "communication_task_closed_at_shape",
      sql`(${t.status} IN ('done', 'cancelled')) = (${t.closedAt} IS NOT NULL)`,
    ),
  }),
);

export const communicationTaskEvents = pgTable(
  "communication_task_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    eventType: text("event_type").notNull(),
    /** Null for the system actor (offboarding). */
    actorUserId: uuid("actor_user_id"),
    actorKind: text("actor_kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    fromAssigneeId: uuid("from_assignee_id"),
    toAssigneeId: uuid("to_assignee_id"),
    /** A closing reason code, or 'manual' | 'offboarding' on a reassignment. */
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskFk: foreignKey({
      name: "communication_task_event_task_fk",
      columns: [t.organizationId, t.taskId],
      foreignColumns: [communicationTasks.organizationId, communicationTasks.id],
    }).onDelete("cascade"),
    byTask: index("communication_task_event_task_idx").on(t.organizationId, t.taskId, t.createdAt),
    typeShape: check(
      "communication_task_event_type_shape",
      sql`${t.eventType} IN ('created', 'accepted', 'done', 'cancelled', 'reassigned', 'needs_owner')`,
    ),
    actorShape: check(
      "communication_task_event_actor_shape",
      sql`${t.actorKind} IN ('user', 'system') AND ((${t.actorKind} = 'system') = (${t.actorUserId} IS NULL))`,
    ),
  }),
);

export type CommunicationTaskRow = typeof communicationTasks.$inferSelect;
export type NewCommunicationTaskRow = typeof communicationTasks.$inferInsert;
export type CommunicationTaskEventRow = typeof communicationTaskEvents.$inferSelect;
export type NewCommunicationTaskEventRow = typeof communicationTaskEvents.$inferInsert;
