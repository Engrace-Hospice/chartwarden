// @wardenx/db — M24 Billing — Medicaid schema barrel (§3.3, 14 owned tables). Re-exports the shared enums
// plus every table module; the central ../index.ts re-exports this barrel.
//
// Tenancy (ADR-0010 / ARCH-011, §3.3): Medicaid billing is per-CCN (ProviderEntity). The tenancy spine
// resolves at the PE-scoped root claim and the subtree inherits it. All 14 tables carry organization_id
// NOT NULL → the canonical app.org_id RLS predicate applies directly (single org-only policy, ADR-0010 D3;
// provider-entity narrowing is M3 ABAC, NOT a second permissive RLS policy). location_id is nullable
// throughout (claims are PE-scoped, not Location-scoped).
//
// Partitioning (§3.2): medicaid_claim / medicaid_claim_line are PARTITION BY LIST(provider_entity_id);
// medicaid_claim_state_history / medicaid_validation_run / medicaid_validation_result / rb_day are
// PARTITION BY LIST(organization_id). Each carries a composite PK including the partition key. Drizzle here
// is the LOGICAL shape only — the LIST partition DDL + DEFAULT partition, RLS, grants and M4 write-audit
// triggers land in SQL 0092–0097.
//
// CROSS-MODULE FK POLICY (architecture wins): cross-module FK constraints are FORBIDDEN. Only organization_id
// / provider_entity_id / location_id (M1 core) + intra-M24 non-partitioned parents (medicaid_submission,
// rb_arrangement) get real `.references(...)`. patient_id (M5), admission_id / loc_period_id (M6),
// encounter_id (M8), medicare_claim_id (M23), state_plan_code_id / mco_id / nf_facility_mdm_id (M40),
// contract_document_id (M22) and all partitioned-parent references are LOGICAL uuid. The state Medicaid
// Recipient ID digits are NEVER stored or audit-captured (D12/§3.6 — masked-at-check + KMS-wrapped blob only).

// shared enums (11)
export * from "./enums";

// 14 owned tables (§3.3)
export * from "./claim"; // medicaid_claim, medicaid_claim_line, medicaid_claim_line_encounter
export * from "./claim-history"; // medicaid_claim_state_history
export * from "./submission"; // medicaid_submission, medicaid_acknowledgment
export * from "./validation"; // medicaid_validation_run/_result/_override/_rule_config
export * from "./eligibility"; // medicaid_eligibility_check
export * from "./room-and-board"; // rb_arrangement, rb_day
export * from "./trading-partner"; // state_medicaid_trading_partner_credential
