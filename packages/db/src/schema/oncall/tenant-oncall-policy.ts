// @chartwarden/db — `tenant_oncall_policy` (M19 §3.3). D3/D7: the per-(org, ProviderEntity) after-hours
// deployment posture — which model the tenant runs, its escalation ladder, its callback SLA per severity,
// and the two AI feature gates. It is ORG-LEVEL CONFIGURATION, not patient data: no patient column, no
// location column, and the row is never touched by the §3.7 eraser (the M11 `order_verbal_policy` / M13
// `administration_policy` posture).
//
// D7 — WHY THE SHIFT SNAPSHOTS THIS ROW: `on_call_shift.policy_snapshot` pins this row's JSON at the
// moment a shift opens, so a policy edited on Tuesday does not retroactively rewrite what was in effect
// during Monday night. This table is therefore the CURRENT posture only; the survey answer for a past
// night is read off the shift.
//
// §2.7 D-D FOLD (documented): `emergency_contact_e164` is NOT in the §3.3 Drizzle block, but §2.7's
// degraded-mode class D-D names it — when M36's alert circuit-breaker is open, M19 surfaces
// "`tenant_oncall_policy.emergency_contact_e164`" to any authenticated org-admin hitting the status
// endpoint. Without the column the D-D fallback is unimplementable, and D-D is the path that runs when
// the alerting fabric is down at 2 a.m. Same class of finding as the `paper_origin` enum value M19-T01
// added (a §3.3 amendment that never reached the sibling block). It is the AGENCY's own published
// after-hours number, not a caller's — hence not in the §3.6 denylist.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { oncallModel } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { externalTriageVendor } from "./external-triage-vendors";

export const tenantOncallPolicy = pgTable(
  "tenant_oncall_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    /** D3 — `direct` is the only model enabled in Phase 1; the other two ride a per-customer flag. */
    model: oncallModel("model").notNull().default("direct"),
    /** D7 — the tenant's tier ladder (tier → recipient role/membership resolution). */
    escalationTiers: jsonb("escalation_tiers").notNull(),
    /** Callback-target minutes per severity; the §4.8 SLA-breach detector reads it. */
    callbackSlaPerSeverity: jsonb("callback_sla_per_severity").notNull(),
    /** State-specific overrides (tighten-only; the platform floor cannot be lowered). */
    stateOverrides: jsonb("state_overrides").notNull().default(sql`'{}'::jsonb`),

    /** Set for the `hybrid` / `centralized` models — see the vendor-required CHECK. */
    externalTriageVendorId: uuid("external_triage_vendor_id").references(
      () => externalTriageVendor.id,
      { onDelete: "restrict" },
    ),

    /** §2.7 D-D — the agency's own after-hours number, surfaced when M36 delivery is degraded. */
    emergencyContactE164: text("emergency_contact_e164"),

    /** D11/D12 — the two ADVISORY M32 surfaces. Default OFF: an AI surface a tenant never enabled must
     *  never call out, and `ai.full` is not granted in Phase 1 anyway. */
    aiProtocolSuggestionEnabled: boolean("ai_protocol_suggestion_enabled").notNull().default(false),
    aiHospitalizationRiskEnabled: boolean("ai_hospitalization_risk_enabled")
      .notNull()
      .default(false),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perProviderEntityUq: uniqueIndex("tenant_oncall_policy_pe_uq").on(
      t.organizationId,
      t.providerEntityId,
    ),
    // §2.3 — a non-Direct model without a vendor identity is a policy that names no one for the nights it
    // covers. Written as `model = 'direct' OR vendor IS NOT NULL` so the Direct case stays unconstrained.
    vendorRequiredOffDirect: check(
      "m19_tenant_oncall_policy_vendor_required",
      sql`"model" = 'direct' OR "external_triage_vendor_id" IS NOT NULL`,
    ),
  }),
);

export type TenantOncallPolicyRow = typeof tenantOncallPolicy.$inferSelect;
export type NewTenantOncallPolicyRow = typeof tenantOncallPolicy.$inferInsert;
