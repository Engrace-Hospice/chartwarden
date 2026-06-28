// @wardenx/db — `cost_report_validation_result` (M27 §3.3, D9; non-partitioned; retention
// `compliance`). One row per rule applied in a validation run. `details` (remediation hints / computed
// values) is captured fully in audit (small + important for replay, §3.6). ORG-SCOPED. No PHI (D18).
import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReportValidation } from "./cost-report-validation";
import { costReportValidationRule } from "./cost-report-validation-rule";
import type { ValidationResultDetails } from "./types";

export const m27ValidationOutcome = pgEnum("m27_validation_outcome", [
  "pass",
  "fail",
  "warn",
  "skip",
]);

export const costReportValidationResult = pgTable(
  "cost_report_validation_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    validationId: uuid("validation_id")
      .notNull()
      .references(() => costReportValidation.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => costReportValidationRule.id),
    outcome: m27ValidationOutcome("outcome").notNull(),
    details: jsonb("details").$type<ValidationResultDetails>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxValOutcome: index("idx_val_result_validation_outcome").on(t.validationId, t.outcome),
  }),
);

export type CostReportValidationResult = typeof costReportValidationResult.$inferSelect;
export type NewCostReportValidationResult = typeof costReportValidationResult.$inferInsert;
