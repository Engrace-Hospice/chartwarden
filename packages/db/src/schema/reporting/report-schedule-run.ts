// @chartwarden/db — `report_schedule_run` (M33 §3.3). The per-occurrence run ledger for a scheduled
// report: the scheduled_for slot, lifecycle status, the M22 document back-ref once rendered, and
// failure/row-count telemetry. ORG-SCOPED: carries organization_id NOT NULL → standard app.org_id
// RLS. PARTITION BY RANGE (scheduled_for) monthly (retention class `operational`): the Drizzle
// definition here is the LOGICAL shape — composite PK (id, scheduled_for) including the partition
// key (check-ddl-legality Rule 1); the PARTITION BY + monthly children + DEFAULT catch-all, plus the
// per-leaf UNIQUE (schedule_id, scheduled_for) idempotency index (which omits-but-here-includes the
// partition key) land in the M33 RLS migration (the EVV `0047` precedent). `schedule_id` refs
// report_schedule; the M22 document_id back-ref is plain uuid app-validated. RLS + grants + the M4
// write-audit trigger also land in that migration.
import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reportSchedule } from "./report-schedule";

export const reportScheduleRun = pgTable(
  "report_schedule_run",
  {
    id: uuid("id").notNull(), // composite PK with scheduled_for (the partition key)
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => reportSchedule.id),
    organizationId: uuid("organization_id").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status", {
      enum: ["queued", "running", "rendered_pending", "rendered_complete", "delivered", "failed"],
    })
      .notNull()
      .default("queued"),
    documentId: uuid("document_id"), // back-ref to M22 once rendered
    failureReason: text("failure_reason"),
    rowCount: integer("row_count"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.scheduledFor] }), // partition key must be in the PK
    // §3.4: per-leaf UNIQUE (schedule_id, scheduled_for) for idempotency — declared plain here,
    // re-added as per-LEAF UNIQUE in the migration (the EVV per-leaf precedent).
    scheduleScheduledFor: index("report_schedule_run_schedule_scheduled_for_idx").on(
      t.scheduleId,
      t.scheduledFor,
    ),
    // §3.4: the operations worklist.
    statusOrg: index("report_schedule_run_status_org_idx").on(t.status, t.organizationId),
  }),
);

export type ReportScheduleRun = typeof reportScheduleRun.$inferSelect;
export type NewReportScheduleRun = typeof reportScheduleRun.$inferInsert;
