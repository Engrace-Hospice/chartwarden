// @chartwarden/db — Module 32 (AI Platform) schema barrel: the thirteen `ownedTables`
// `architecture/module-manifest.ts` gives M32, in three tenancy layers (§3.3).
//
// PLATFORM-SHARED (six) — no organization_id, read-all within any tenant, writes via `wardenx_admin`.
// The governance surface is deliberately world-readable inside the platform: a tenant has to be able to
// see WHICH capabilities exist to opt in to one, and a per-tenant copy of the model registry would let
// two tenants disagree about which model version answered.
//   ai_capability · ai_capability_lifecycle_event · ai_capability_calibration · ai_model_backend ·
//   ai_prompt_template · ai_evaluation_run
//
// TENANT-SCOPED (six) — organization_id NOT NULL, RLS keyed ONLY on app.org_id.
//   ai_tenant_opt_in_record · ai_clinician_opt_out · ai_invocation · ai_token_ledger ·
//   ai_hallucination_report · ai_routing_override
//
// MIXED (one) — ai_kill_switch_state, whose organization_id is NULLABLE and whose NULL means a
// platform-wide kill. Read spans both; INSERT/UPDATE are tenant-only, so `wardenx_app` cannot mint a
// kill that stops the capability for every other tenant.
//
// TWO ARE PARTITIONED MONTHLY (§3.8) and therefore carry a composite primary key declared in SQL:
// `ai_invocation` on `invoked_at` (7-year retention — it is the §164.528 disclosure evidence) and
// `ai_token_ledger` on `accrued_at` (6 years — the M35 SaaS billing trail). They live in their own
// migrations (0114, 0115) because check-ddl-legality derives ONE partition column per file.
//
// THE THREE-COLUMN RULE beyond §3.2: `ai_invocation` and `ai_hallucination_report` additionally carry
// provider_entity_id NOT NULL + location_id nullable. ARCH-011 requires it of a PHI-bearing table and
// architecture wins over a module spec; both tables are PHI-bearing (the invocation by definition, the
// report through the clinician's narrative quoting what the model fabricated about a patient).
//
// Enums land in `packages/db/src/enums.ts` (M32-T01). Tables in migrations 0113–0115; RLS/grants, the
// M4 write-audit triggers and the §3.5 immutability triggers in 0116.
export * from "./ai-capabilities";
export * from "./ai-capability-calibrations";
export * from "./ai-capability-lifecycle-events";
export * from "./ai-clinician-opt-outs";
export * from "./ai-evaluation-runs";
export * from "./ai-hallucination-reports";
export * from "./ai-invocations";
export * from "./ai-kill-switch-states";
export * from "./ai-model-backends";
export * from "./ai-prompt-templates";
export * from "./ai-routing-overrides";
export * from "./ai-tenant-opt-in-records";
export * from "./ai-token-ledger";
