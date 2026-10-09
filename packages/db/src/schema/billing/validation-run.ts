// @wardenx/db — `validation_run` (M23 Billing-Medicare §3.3, D5; append-only; retention class
// `operational`). One row per claim validation cycle: the rule engine in `@wardenx/billing` records a
// run for each (claim, trigger) pass, with idempotent collapse on `run_input_hash`. ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS).
//
// PARTITIONING (declared in the SQL migration 0074+, NOT in Drizzle — Drizzle only carries the
// columns/indexes/types): LIST-partitioned on organization_id, then each org leaf sub-partitioned by
// started-at RANGE MONTHLY (kernel conventions report; spec §3.2 Phase B). The migration agent MUST
// emit the list-then-range monthly partition DDL + register the table with M4's partition rotation
// manager (spec §3.2 Phase F). Drizzle's pgTable below is the logical shape only.
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only `organization_id` (core) and
// intra-M23 parents (`claim_id` → claim) get real `.references(...)`. `initiated_by_membership_id`
// (core memberships) is a LOGICAL FK — plain uuid, validated at runtime (mirrors the M27 cost-report
// precedent). No PHI / MBI is ever stored here (D13, §8.7).
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import { m23ValidationRunOutcome, m23ValidationRunTrigger } from "./types";

export const validationRun = pgTable(
  "validation_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    trigger: m23ValidationRunTrigger("trigger").notNull(),
    outcome: m23ValidationRunOutcome("outcome").notNull(),

    // Idempotency: identical (organization_id, claim_id, trigger, run_input_hash) collapses to one row.
    runInputHash: text("run_input_hash").notNull(), // sha256 of claim version + upstream-reader fingerprints

    // Run stats:
    rulesExecuted: integer("rules_executed").notNull(),
    rulesPassed: integer("rules_passed").notNull(),
    rulesFailed: integer("rules_failed").notNull(),
    rulesWarn: integer("rules_warn").notNull(),
    rulesInfo: integer("rules_info").notNull(),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),

    initiatedByMembershipId: uuid("initiated_by_membership_id"), // logical FK → memberships (NULL for system triggers)
  },
  (t) => ({
    claimRecent: index("validation_run_claim_recent_idx").on(t.claimId, t.startedAt),
    // Matches migration 0076 (`organization_id` leads the index) — the repository's ON CONFLICT target must
    // list exactly these columns for Postgres to infer the arbiter index.
    idempotency: uniqueIndex("validation_run_idempotency_uq").on(
      t.organizationId,
      t.claimId,
      t.trigger,
      t.runInputHash,
    ),
  }),
);

export type ValidationRun = typeof validationRun.$inferSelect;
export type NewValidationRun = typeof validationRun.$inferInsert;
