// @chartwarden/db — `cost_report_validation_override` (M27 §3.3, D9/D14; non-partitioned; retention
// `compliance`). A per-result override of a failing rule, requiring elevated approval + step-up + a
// reason (the override is an attack surface — the auditor needs who-overrode-what-rule-when). UNIQUE per
// validation_result_id (one override per failure). INSERT-only in practice. ORG-SCOPED. No PHI (D18).
import { index, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { costReportValidationResult } from "./cost-report-validation-result";

export const costReportValidationOverride = pgTable(
  "cost_report_validation_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    validationResultId: uuid("validation_result_id")
      .notNull()
      .references(() => costReportValidationResult.id, { onDelete: "cascade" }),
    overriddenByMembershipId: uuid("overridden_by_membership_id").notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOverrideResult: unique("uniq_override_result").on(t.validationResultId),
    idxOrg: index("idx_override_org").on(t.organizationId, t.overriddenAt),
  }),
);

export type CostReportValidationOverride = typeof costReportValidationOverride.$inferSelect;
export type NewCostReportValidationOverride = typeof costReportValidationOverride.$inferInsert;
