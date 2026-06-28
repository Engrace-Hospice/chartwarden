// @wardenx/db — `cost_report_compliance_window` (M27 §3.3, D15; non-partitioned; retention
// `compliance`). The filing-deadline timer (one per cost report, UNIQUE cost_report_id): cost reports
// are due FYE + 5 months (42 CFR §413.24(f)). The cron scan emits tiered M36 alerts
// (t4_months → t4_5_months → t4_75_months → past_deadline); MAC-granted extensions update
// current_effective_deadline_date and reset the cadence. Mirrors M6's compliance-window pattern.
// ORG-SCOPED. No PHI (D18).
import { date, index, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";

export const m27AlertTier = pgEnum("m27_alert_tier", [
  "none",
  "t4_months",
  "t4_5_months",
  "t4_75_months",
  "past_deadline",
]);

export const costReportComplianceWindow = pgTable(
  "cost_report_compliance_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .unique()
      .references(() => costReport.id, { onDelete: "cascade" }),
    deadlineDate: date("deadline_date").notNull(), // FYE + 5 months
    currentEffectiveDeadlineDate: date("current_effective_deadline_date").notNull(), // FYE+5mo OR extension
    lastAlertTierEmittedAt: timestamp("last_alert_tier_emitted_at", { withTimezone: true }),
    lastAlertTier: m27AlertTier("last_alert_tier").notNull().default("none"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    idxOrgDeadline: index("idx_window_org_deadline").on(
      t.organizationId,
      t.currentEffectiveDeadlineDate,
    ),
    idxLastTier: index("idx_window_last_tier").on(t.lastAlertTier, t.currentEffectiveDeadlineDate),
  }),
);

export type CostReportComplianceWindow = typeof costReportComplianceWindow.$inferSelect;
export type NewCostReportComplianceWindow = typeof costReportComplianceWindow.$inferInsert;
