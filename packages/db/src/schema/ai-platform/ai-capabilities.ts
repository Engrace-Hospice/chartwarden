// @wardenx/db — `ai_capability` (M32 §3.2.1). The governance registry: one row per AI capability the
// platform can offer, carrying D2's lifecycle state, its risk tier, its routing chain and the FDA SaMD
// posture it was registered under.
//
// PLATFORM-SHARED, NOT ORG-SCOPED (§3.3 / System Design §4.6). There is deliberately no
// organization_id: the catalog is world-readable WITHIN the platform because a tenant must be able to
// see WHICH capabilities exist in order to opt in to one, and the per-tenant answer lives in
// `ai_tenant_opt_in_record`. Writes are `wardenx_admin` only, so a tenant can never promote a capability
// for everyone. The table is listed in check-tenancy.ts's NON_ORG_SCOPED set with that justification.
//
// `default_backend_key` / `allowed_backend_keys` / `fallback_chain_keys` are KEYS, not FKs, and that is
// §3.2.1's explicit choice: `ai_model_backend` is an independent registry that can be rewritten by a
// vendor-version bump, and a hard FK would make retiring a backend require rewriting every capability
// row that ever named it. The routing gate resolves the keys at invoke time and fails CLOSED on an
// unresolvable one.
//
// THE ONE CHECK THAT MATTERS is `ai_capability_approved_has_template`: a capability cannot sit at
// APPROVED or MONITORING without naming the prompt template it runs. Without it a capability could go
// generally-available with nothing to execute, and the failure would surface as a null-deref at the
// first real invocation rather than at the promotion that caused it.
//
// §3.2.1's `checkLifecycle` CHECK is deliberately NOT reproduced: `lifecycle_state` IS the
// `ai_capability_lifecycle_state` pgEnum, so the CHECK restates the column type — and a redundant
// value list is a DRIFT HAZARD, not a belt-and-braces (add a ninth state to the enum and the CHECK
// silently refuses every row carrying it). The type is the constraint.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  aiCapabilityLifecycleState,
  aiCapabilityOwningRole,
  aiCapabilityRiskTier,
  aiFdaSamdClassification,
} from "../../enums";

export const aiCapability = pgTable(
  "ai_capability",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Stable machine key — 'hearthnote_layer2'. Every seam, permission and ledger row names THIS.
     *  Uniqueness is the named `ai_capability_key_idx` below, NOT a column `.unique()`: §3.2.1 writes
     *  both, and two declarations produce two constraints on one column. */
    capabilityKey: text("capability_key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),

    riskTier: aiCapabilityRiskTier("risk_tier").notNull(),
    lifecycleState: aiCapabilityLifecycleState("lifecycle_state").notNull().default("PROPOSED"),

    /** FK-LIKE (see header): resolved against `ai_model_backend.backend_key` at routing time. */
    defaultBackendKey: text("default_backend_key").notNull(),
    /** string[] — the backends this capability may EVER route to. */
    allowedBackendKeys: jsonb("allowed_backend_keys").notNull(),
    /** string[] — ordered fallback chain consumed by the W2/W8 routing gate. */
    fallbackChainKeys: jsonb("fallback_chain_keys").notNull(),

    tenantOverrideAllowed: boolean("tenant_override_allowed").notNull().default(false),
    tenantOptInRequired: boolean("tenant_opt_in_required").notNull().default(true),
    clinicianOptOutSupported: boolean("clinician_opt_out_supported").notNull().default(true),
    clinicalReviewRequired: boolean("clinical_review_required").notNull().default(false),

    owningRole: aiCapabilityOwningRole("owning_role").notNull().default("ai_safety_owner"),
    marketingDisclosureTemplate: text("marketing_disclosure_template"),
    fdaSamdClassification: aiFdaSamdClassification("fda_samd_classification")
      .notNull()
      .default("not_samd"),

    /** The `ai_prompt_template.template_key` this capability currently executes (see the CHECK). */
    currentPromptTemplateKey: text("current_prompt_template_key"),

    firstApprovedAt: timestamp("first_approved_at", { withTimezone: true }),
    lastReapprovedAt: timestamp("last_reapproved_at", { withTimezone: true }),
    nextReapprovalDueAt: timestamp("next_reapproval_due_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    capabilityKeyIdx: uniqueIndex("ai_capability_key_idx").on(t.capabilityKey),
    lifecycleIdx: index("ai_capability_lifecycle_idx").on(t.lifecycleState),
    riskTierIdx: index("ai_capability_risk_tier_idx").on(t.riskTier),
    // The reapproval sweep only ever asks about live capabilities — a partial index keeps the
    // PROPOSED/RETIRED bulk out of it.
    reapprovalDueIdx: index("ai_capability_reapproval_due_idx")
      .on(t.nextReapprovalDueAt)
      .where(sql`lifecycle_state IN ('APPROVED','MONITORING')`),

    approvedHasTemplate: check(
      "ai_capability_approved_has_template",
      sql`lifecycle_state NOT IN ('APPROVED','MONITORING') OR current_prompt_template_key IS NOT NULL`,
    ),
  }),
);

export type AiCapabilityRow = typeof aiCapability.$inferSelect;
export type NewAiCapabilityRow = typeof aiCapability.$inferInsert;
