// @wardenx/db — `validation_result` (M23 Billing-Medicare §3.3 / §3.4, D5; append-only; retention
// class `operational`). One row per (validation_run, rule): the per-rule outcome + structured
// remediation hint produced by the `@wardenx/billing` rule engine. ORG-SCOPED: organization_id NOT
// NULL (canonical app.org_id RLS).
//
// PARTITIONING (declared in the SQL migration 0074+, NOT in Drizzle — Drizzle only carries the
// columns/indexes/types): PARTITION BY LIST (organization_id) then sub-partition each org list by
// RANGE (recorded_at) MONTHLY (kernel conventions report; spec §3.2 Phase B). The migration agent MUST
// emit the LIST→RANGE monthly partition DDL + register the table with M4's partition rotation manager
// (spec §3.2 Phase F). Drizzle's pgTable below is the logical shape only.
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only `organization_id` (core) and
// intra-M23 parents (`validation_run_id` → validation_run) get real `.references(...)`. `override_id`
// is a LOGICAL FK — plain uuid (validation_override references validation_result, so a real FK would be
// circular; resolved via validation_override.result_id). No PHI / MBI is ever stored here (D13, §8.7).
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { validationRun } from "./validation-run";
import { m23ValidationResultOutcome, m23ValidationSeverity } from "./types";

export const validationResult = pgTable(
  "validation_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    validationRunId: uuid("validation_run_id")
      .notNull()
      .references(() => validationRun.id, { onDelete: "restrict" }),

    ruleKey: text("rule_key").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    severity: m23ValidationSeverity("severity").notNull(),
    outcome: m23ValidationResultOutcome("outcome").notNull(),

    // Structured remediation hint (typed per rule kind at the service layer in `@wardenx/billing`;
    // opaque at the DB layer — default '{}'::jsonb).
    remediation: jsonb("remediation").notNull().default(sql`'{}'::jsonb`),

    // Override link (populated when an override row exists; lookup via validation_override.result_id):
    overrideId: uuid("override_id"), // logical FK → validation_override (circular if real)

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index("validation_result_run_idx").on(t.validationRunId),
    failedIdx: index("validation_result_failed_idx")
      .on(t.organizationId, t.outcome)
      .where(sql`outcome = 'fail'`),
    // §3.4 critical index — per-claim worklist scans the smallest possible set:
    failedPerClaim: index("validation_result_failed_per_claim")
      .on(t.organizationId, t.validationRunId)
      .where(sql`outcome = 'fail'`),
  }),
);

export type ValidationResult = typeof validationResult.$inferSelect;
export type NewValidationResult = typeof validationResult.$inferInsert;
