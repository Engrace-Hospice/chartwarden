// @wardenx/db — `tenant_step_up_policy_override` (M2 Identity §3.7, M02-F04). Lets a
// tenant TIGHTEN — never loosen — the platform-floor step-up policy per operation
// (the tighten-only invariant is enforced by a trigger in Module 2's later tasks; the
// STEP_UP_POLICY floor constant lands in M2-T04). Org-scoped: carries `organization_id`,
// lives under `app.org_id` RLS, and gets a write-audit trigger (phi-guards). Not PHI, so
// the three-column rule's provider_entity_id/location_id do not apply.
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { stepUpFactor } from "../enums";
import { memberships } from "./memberships";
import { organizations } from "./organizations";

export const tenantStepUpPolicyOverride = pgTable(
  "tenant_step_up_policy_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operationKey: text("operation_key").notNull(),
    qualifyingFactors: stepUpFactor("qualifying_factors").array().notNull(),
    maxAgeSec: integer("max_age_sec").notNull(),
    rationale: text("rationale").notNull(),
    configuredByMembershipId: uuid("configured_by_membership_id")
      .notNull()
      .references(() => memberships.id),
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // AC-03 (migration 0211). One policy per (tenant, operation): nothing constrained this before,
    // so two rows for one operation were legal and which one applied was whatever the planner
    // returned first. The tighten-only invariant itself is `trg_tenant_step_up_tighten_only` — a
    // BEFORE trigger, not expressible here, because it compares the row against the platform floor.
    orgOperationUnique: uniqueIndex("tenant_step_up_override_org_operation_uq").on(
      t.organizationId,
      t.operationKey,
    ),
  }),
);

export type TenantStepUpPolicyOverride = typeof tenantStepUpPolicyOverride.$inferSelect;
export type NewTenantStepUpPolicyOverride = typeof tenantStepUpPolicyOverride.$inferInsert;
