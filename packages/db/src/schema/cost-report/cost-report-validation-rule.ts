// @wardenx/db — `cost_report_validation_rule` (M27 §3.3, D16/D21; non-partitioned; retention
// `operational`). The configurable rule library: platform defaults (organization_id NULL) layered with
// per-tenant rules. `regulatory_required` rules cannot be tenant-disabled; MAC-jurisdiction-scoped rules
// ship additively (NGS-J6 Phase 1). `predicate_spec` is consumed by the rule-engine (P2). NOTE: this is
// the one M27 table with a NULLABLE organization_id (platform-default rows) — declared on the
// check-tenancy partial allowlist (the M3 permission-catalog precedent). No PHI (D18).
import { index, jsonb, pgEnum, pgTable, timestamp, integer, unique, uuid, varchar, boolean } from "drizzle-orm/pg-core";
import type { RulePredicateSpec } from "./types";

export const m27RuleCategory = pgEnum("m27_rule_category", [
  "demographics_ownership",
  "statistical_data",
  "trial_balance",
  "reclassifications",
  "adjustments",
  "cost_allocation",
  "ancillary_apportionment",
  "apportionment_programs",
  "settlement",
  "balance_sheet",
  "cap",
  "bad_debt",
  "cross_worksheet",
  "mac_specific",
  "supporting_docs",
  "filing_deadline",
]);

export const m27RuleSeverity = pgEnum("m27_rule_severity", ["block", "warn", "info"]);
export const m27RuleStatus = pgEnum("m27_rule_status", ["active", "deprecated", "draft_suggestion"]);

export const costReportValidationRule = pgTable(
  "cost_report_validation_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id"), // NULL = platform default (NON_ORG_SCOPED allowlist)
    ruleCode: varchar("rule_code", { length: 80 }).notNull(),
    category: m27RuleCategory("category").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    ruleSetVersion: integer("rule_set_version").notNull(),
    regulatoryRequired: boolean("regulatory_required").notNull().default(false),
    severity: m27RuleSeverity("severity").notNull(),
    status: m27RuleStatus("status").notNull().default("active"),
    macJurisdictionScope: varchar("mac_jurisdiction_scope", { length: 200 })
      .notNull()
      .default("all"),
    predicateSpec: jsonb("predicate_spec").$type<RulePredicateSpec>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  },
  (t) => ({
    uniqOrgCodeVersion: unique("uniq_rule_org_code_version").on(
      t.organizationId,
      t.ruleCode,
      t.ruleSetVersion,
    ),
    idxStatus: index("idx_rule_status").on(t.status, t.severity),
  }),
);

export type CostReportValidationRule = typeof costReportValidationRule.$inferSelect;
export type NewCostReportValidationRule = typeof costReportValidationRule.$inferInsert;
