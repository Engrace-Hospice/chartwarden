// @wardenx/db — `feature_flag` + `feature_flag_evaluation` (M1 Foundation §3.10).
// Feature flags support four governance patterns (enums.featureFlagKind):
//   - 'product'     — long-lived behavior toggle (e.g. ai.hearthnote_layer2_enabled)
//   - 'rollout'     — percentage-based rollout (rollout_percent, deterministic bucket)
//   - 'kill_switch' — emergency disable; default-off; bypasses cache
//   - 'migration'   — temporary, tied to a deployment; auto-expires (expires_at)
// organization_id is nullable: null = a platform-global flag. Targeting predicates
// let a flag's value vary by tenant role / user / location / ProviderEntity.
// NON_ORG_SCOPED in check-tenancy.ts — it owns its global+own read policy (ADR-0010 D3).
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { featureFlagKind, featureFlagValueType } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const featureFlags = pgTable(
  "feature_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }), // null = platform-global flag
    flagKey: text("flag_key").notNull(),
    flagKind: featureFlagKind("flag_kind").notNull().default("product"),
    valueType: featureFlagValueType("value_type").notNull(),
    value: jsonb("value").notNull(), // default value when no targeting matches
    // Rollout: percentage of users (or tenants if global) bucketed deterministically
    // by hash of (flagKey, targetingKey) so a given subject sees a stable value.
    rolloutPercent: integer("rollout_percent"),
    // Targeting predicates (evaluated in order; first match wins).
    targeting: jsonb("targeting").notNull().default([]),
    // Kill switch: when true the flag returns 'false' regardless of other config and
    // bypasses any caching. Used for emergency disables.
    killSwitchActive: boolean("kill_switch_active").notNull().default(false),
    // Migration flags: no-op (returns default) after expires_at — prevents migration
    // flags from becoming permanent technical debt.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rationale: text("rationale"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    // The normative SQL (migration 0237) adds NULLS NOT DISTINCT. It is load-bearing: organization_id
    // is NULL for a platform-global flag, and without the clause the global scope is unconstrained —
    // duplicate global rows for one key are legal AND an `ON CONFLICT (flag_key, organization_id)`
    // upsert can never match one, so the admin write degrades to create-only (F-091).
    keyOrgUniqueIdx: uniqueIndex("feature_flag_key_org_idx").on(t.flagKey, t.organizationId),
    kindIdx: index("feature_flag_kind_idx").on(t.flagKind),
    expiresIdx: index("feature_flag_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Feature flag evaluation history — audit trail of every evaluation for
 * kill-switched, rollout, and migration flags (not product flags, which would flood
 * the table). Monthly-partitioned + retention-classed in ops (M01-F11); the Drizzle
 * shape stays flat and the migration (M1-T04) owns any partition DDL.
 */
export const featureFlagEvaluations = pgTable(
  "feature_flag_evaluation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => featureFlags.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id"),
    userId: uuid("user_id"),
    evaluatedValue: jsonb("evaluated_value").notNull(),
    targetingMatched: text("targeting_matched"), // which targeting rule matched, if any
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flagEvaluatedIdx: index("feature_flag_eval_flag_idx").on(t.flagId, t.evaluatedAt),
  }),
);

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
export type FeatureFlagEvaluation = typeof featureFlagEvaluations.$inferSelect;
export type NewFeatureFlagEvaluation = typeof featureFlagEvaluations.$inferInsert;
