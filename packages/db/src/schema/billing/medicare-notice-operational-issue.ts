// M23-CM-4C.3B — durable, non-PHI operational follow-up for Medicare notices.
// Notice source facts remain owned by their original modules; this table stores only references,
// stable reason codes, assignment and lifecycle. DDE remains the specialized FISS work queue.
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const MEDICARE_NOTICE_ISSUE_TYPES = ["noe", "notr", "transfer", "cancellation"] as const;
export const MEDICARE_NOTICE_ISSUE_STATUSES = [
  "active",
  "acknowledged",
  "assigned",
  "resolved",
  "superseded",
] as const;
export const medicareNoticeOperationalIssue = pgTable(
  "medicare_notice_operational_issue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    noticeType: text("notice_type").$type<(typeof MEDICARE_NOTICE_ISSUE_TYPES)[number]>().notNull(),
    noticeId: uuid("notice_id").notNull(), // logical FK to the type-specific M23 notice row
    issueCode: text("issue_code").notNull(),
    occurrenceKey: text("occurrence_key").notNull(), // source/evidence version; no patient content
    status: text("status")
      .$type<(typeof MEDICARE_NOTICE_ISSUE_STATUSES)[number]>()
      .notNull()
      .default("active"),
    severity: text("severity").$type<"info" | "warning" | "critical">().notNull(),
    responsibleArea: text("responsible_area").notNull(),
    ddeWorkItemId: uuid("dde_work_item_id"), // logical link only; DDE owns its own lifecycle
    assignedMembershipId: uuid("assigned_membership_id"), // logical FK; same-org active membership checked by DB trigger
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    openOccurrence: uniqueIndex("med_notice_issue_open_occurrence_uq")
      .on(t.organizationId, t.noticeType, t.noticeId, t.issueCode)
      .where(sql`status IN ('active','acknowledged','assigned')`),
    historyLookup: index("med_notice_issue_history_ix").on(
      t.organizationId,
      t.noticeType,
      t.noticeId,
      t.createdAt,
      t.id,
    ),
    worklist: index("med_notice_issue_worklist_ix").on(
      t.organizationId,
      t.status,
      t.severity,
      t.lastEvaluatedAt,
    ),
    assignee: index("med_notice_issue_assignee_ix")
      .on(t.organizationId, t.assignedMembershipId)
      .where(sql`assigned_membership_id IS NOT NULL`),
  }),
);

export const medicareNoticeOperationalIssueEvent = pgTable(
  "medicare_notice_operational_issue_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type")
      .notNull()
      .$type<
        | "detected"
        | "severity_changed"
        | "escalated"
        | "assigned"
        | "reassigned"
        | "acknowledged"
        | "resolved"
        | "superseded"
        | "reopened"
      >(),
    actorMembershipId: uuid("actor_membership_id"), // null for system evaluation
    reasonCode: text("reason_code").notNull(),
    previousState: text("previous_state"),
    nextState: text("next_state").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventOnce: uniqueIndex("med_notice_issue_event_once_uq").on(t.organizationId, t.eventKey),
    history: index("med_notice_issue_event_history_ix").on(
      t.organizationId,
      t.issueId,
      t.occurredAt,
      t.id,
    ),
  }),
);

export const medicareNoticeOperationalIssueNotification = pgTable(
  "medicare_notice_operational_issue_notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    issueEventId: uuid("issue_event_id").notNull(),
    state: text("state").notNull().$type<"pending" | "published">().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventOnce: uniqueIndex("med_notice_issue_notification_event_uq").on(
      t.organizationId,
      t.issueEventId,
    ),
    pending: index("med_notice_issue_notification_pending_ix")
      .on(t.organizationId, t.createdAt)
      .where(sql`state='pending'`),
  }),
);

export type MedicareNoticeOperationalIssueRow = typeof medicareNoticeOperationalIssue.$inferSelect;
export type MedicareNoticeOperationalIssueEventRow =
  typeof medicareNoticeOperationalIssueEvent.$inferSelect;
export type MedicareNoticeOperationalIssueNotificationRow =
  typeof medicareNoticeOperationalIssueNotification.$inferSelect;
