// @chartwarden/db — `cost_report_validation` (M27 §3.3, D9; non-partitioned; retention class `compliance`).
// One row per validation run with rolled-up counts + rule-set-version pinning (a 2027 rule-set update
// does not retroactively alter a 2026 validation history). `failed_to_run` captures infra failures
// (seam unbound, stale pull) distinct from rule failures. ORG-SCOPED. No PHI (D18).
import { index, integer, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReport } from "./cost-report";

export const m27ValidationStatus = pgEnum("m27_validation_status", [
  "in_progress",
  "complete",
  "failed_to_run",
]);

export const costReportValidation = pgTable(
  "cost_report_validation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    costReportId: uuid("cost_report_id")
      .notNull()
      .references(() => costReport.id),
    snapshotId: uuid("snapshot_id"), // logical ref to cost_report_snapshot (nullable; pre-submit runs)
    ruleSetVersion: integer("rule_set_version").notNull(),
    status: m27ValidationStatus("status").notNull(),
    passedCount: integer("passed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    overriddenCount: integer("overridden_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull().defaultNow(),
    runCompletedAt: timestamp("run_completed_at", { withTimezone: true }),
  },
  (t) => ({
    idxOrgReportRun: index("idx_validation_org_report_run").on(
      t.organizationId,
      t.costReportId,
      t.runStartedAt,
    ),
  }),
);

export type CostReportValidation = typeof costReportValidation.$inferSelect;
export type NewCostReportValidation = typeof costReportValidation.$inferInsert;
