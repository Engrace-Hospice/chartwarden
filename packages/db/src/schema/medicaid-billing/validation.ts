// @wardenx/db — M24 Billing — Medicaid §3.3 — the validation registry tables. medicaid_validation_run and
// medicaid_validation_result are PARTITION BY LIST(organization_id) (composite PK (id, organization_id) in
// SQL 0095); medicaid_validation_override and medicaid_validation_rule_config are NON-partitioned (SQL 0093).
//
// CROSS-MODULE / partitioned-parent FK POLICY: organization_id → organizations is the only real FK on the
// partitioned tables. medicaid_validation_run_id / medicaid_validation_result_id / medicaid_claim_id are
// LOGICAL uuid (the run/result parents are partitioned, the claim is partitioned). custom_predicate_dsl is
// tenant-authored (audit-denylisted §3.6).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m24ClaimState, m24ValidationOutcome } from "./enums";

// ---- medicaid_validation_run — one per validation cycle; PARTITION BY LIST(organization_id) ----
export const medicaidValidationRun = pgTable(
  "medicaid_validation_run",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, organization_id) in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }), // partition key
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim
    ruleRegistryVersion: varchar("rule_registry_version", { length: 16 }).notNull(),
    triggeredBy: varchar("triggered_by", { length: 32 }).notNull(),
    triggerSignalId: varchar("trigger_signal_id", { length: 128 }),
    claimStateAtTrigger: m24ClaimState("claim_state_at_trigger").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorMembershipId: uuid("actor_membership_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    totalResults: integer("total_results").notNull().default(0),
    failedResults: integer("failed_results").notNull().default(0),
    warnedResults: integer("warned_results").notNull().default(0),
  },
  (t) => ({
    uniqueIdempotency: index("medicaid_validation_run_unique_idempotency").on(
      t.organizationId,
      t.medicaidClaimId,
      t.idempotencyKey,
    ),
    byClaimAt: index("medicaid_validation_run_by_claim_at").on(t.medicaidClaimId, t.at),
  }),
);

// ---- medicaid_validation_result — one per rule per run; PARTITION BY LIST(organization_id) ----
export const medicaidValidationResult = pgTable(
  "medicaid_validation_result",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, organization_id) in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }), // partition key
    medicaidValidationRunId: uuid("medicaid_validation_run_id").notNull(), // logical FK → run (partitioned)
    ruleKey: varchar("rule_key", { length: 96 }).notNull(),
    ruleVersion: integer("rule_version").notNull(),
    applicableStatesCheck: jsonb("applicable_states_check"),
    outcome: m24ValidationOutcome("outcome").notNull(),
    remediationSummary: text("remediation_summary"),
    remediationBlameTarget: varchar("remediation_blame_target", { length: 32 }),
    remediationBlameTargetId: uuid("remediation_blame_target_id"),
    remediationFixAction: varchar("remediation_fix_action", { length: 64 }),
    remediationFixDeepLink: text("remediation_fix_deep_link"),
    detailsJson: jsonb("details_json"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerRun: index("medicaid_validation_result_unique_per_run").on(
      t.organizationId,
      t.medicaidValidationRunId,
      t.ruleKey,
    ),
    byRunOutcome: index("medicaid_validation_result_by_run_outcome").on(
      t.medicaidValidationRunId,
      t.outcome,
    ),
  }),
);

// ---- medicaid_validation_override — one per overridden failed result (NON-partitioned) ----
export const medicaidValidationOverride = pgTable(
  "medicaid_validation_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    medicaidValidationResultId: uuid("medicaid_validation_result_id").notNull(), // logical FK → result (partitioned)
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim
    ruleKey: varchar("rule_key", { length: 96 }).notNull(),
    overrideRoleApplied: varchar("override_role_applied", { length: 32 }).notNull(),
    reason: text("reason").notNull(),
    stepUpAuthTokenAt: timestamp("step_up_auth_token_at", { withTimezone: true }).notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerResult: index("medicaid_validation_override_unique_per_result").on(
      t.medicaidValidationResultId,
    ),
    reasonLength: check("medicaid_validation_override_reason_length", sql`length(reason) >= 40`),
    stepUpFresh: check(
      "medicaid_validation_override_step_up_fresh",
      sql`step_up_auth_token_at > at - INTERVAL '5 minutes'`,
    ),
  }),
);

// ---- medicaid_validation_rule_config — per-tenant rule overlay (NON-partitioned) ----
export const medicaidValidationRuleConfig = pgTable(
  "medicaid_validation_rule_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ruleKey: varchar("rule_key", { length: 96 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    parametersOverlay: jsonb("parameters_overlay"),
    isCustom: boolean("is_custom").notNull().default(false),
    customPredicateDsl: jsonb("custom_predicate_dsl"), // tenant-authored (denylisted)
    customSeverity: varchar("custom_severity", { length: 16 }),
    customOverrideRole: varchar("custom_override_role", { length: 32 }),
    regulatoryRequiredSnapshot: boolean("regulatory_required_snapshot").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
  },
  (t) => ({
    uniquePerOrg: index("medicaid_validation_rule_config_unique_per_org").on(
      t.organizationId,
      t.ruleKey,
    ),
    regulatoryRequiredNotDisabled: check(
      "medicaid_validation_rule_config_regulatory_required_not_disabled",
      sql`NOT (regulatory_required_snapshot = true AND enabled = false)`,
    ),
    customRequiresDsl: check(
      "medicaid_validation_rule_config_custom_requires_dsl",
      sql`(is_custom = false) OR (is_custom = true AND custom_predicate_dsl IS NOT NULL AND custom_severity IS NOT NULL)`,
    ),
  }),
);
