// @chartwarden/db — `report_schedule` (M33 §3.3). A cron-driven scheduled render of a saved view to a
// recipient list, evaluated in the tenant's IANA timezone. ORG-SCOPED: carries organization_id
// NOT NULL → standard app.org_id RLS (writes additionally require report.schedule.write; recipients
// must be active memberships in the same org, §3.5). `report_view_id` refs report_view; owner +
// recipient membership refs are plain uuid app-validated. `recipient_membership_ids` is captured in
// audit but redacted to role keys in surveyor-mode (§3.6). RLS + grants + the M4 write-audit trigger
// land in the M33 RLS migration.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reportView } from "./report-view";

export const reportSchedule = pgTable(
  "report_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    reportViewId: uuid("report_view_id")
      .notNull()
      .references(() => reportView.id),
    ownerMembershipId: uuid("owner_membership_id").notNull(),
    cronExpression: text("cron_expression").notNull(),
    tenantTimezone: text("tenant_timezone").notNull(), // IANA TZ name; cron evaluated against this
    format: text("format", { enum: ["pdf", "xlsx", "csv"] }).notNull(),
    recipientMembershipIds: jsonb("recipient_membership_ids").notNull().$type<string[]>(),
    deliveryChannel: text("delivery_channel", { enum: ["in_app"] })
      .notNull()
      .default("in_app"), // Phase 2: 'email'
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "paused", "cancelled"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => ({
    // §3.4: the cron evaluator's "what's due" scan.
    orgStatusNextRun: index("report_schedule_org_status_next_run_idx").on(
      t.organizationId,
      t.status,
      t.nextRunAt,
    ),
    // §3.4: "my schedules".
    ownerStatus: index("report_schedule_owner_status_idx").on(t.ownerMembershipId, t.status),
  }),
);

export type ReportSchedule = typeof reportSchedule.$inferSelect;
export type NewReportSchedule = typeof reportSchedule.$inferInsert;
