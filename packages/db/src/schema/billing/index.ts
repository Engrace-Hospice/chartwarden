// @wardenx/db — M23 Billing-Medicare schema barrel (§3.3, 17 spec-owned tables + `unmapped_taxonomy_
// occurrence`, the #248 D13 addition — see that file's own header). Re-exports the shared
// enums/types plus all owned table modules; the central ../index.ts re-exports this barrel.
//
// Tenancy (ADR-0010, canonical): EVERY M23 table carries organization_id NOT NULL, so the canonical
// app.org_id RLS predicate applies directly — EXCEPT `wage_index_factor`, which is PLATFORM-SHARED
// (NO organization_id, D12): it goes on the check-tenancy NON_ORG_SCOPED allowlist with a SELECT-only
// `USING (true)` policy for app_user + full-CRUD for the platform_loader role (spec §3.2 Phase D).
//
// Partitioning: `claim` / `claim_line` are LIST(provider_entity_id)→RANGE(created_at) quarterly;
// `claim_state_history` / `validation_run` / `validation_result` are LIST(organization_id)→RANGE
// monthly; the rest are non-partitioned (spec §3.2 Phase B). Drizzle carries logical shape only — the
// partition DDL + RLS + grants + M4 write-audit triggers land in the SQL migrations 0074+.
//
// CROSS-MODULE FK POLICY: cross-module FK constraints are FORBIDDEN (architecture). Only
// organization_id (core) + intra-M23 parents get real `.references(...)`; provider_entity_id (M40),
// patient/admission/election ids (M5/M6), and *_membership_id (core) are logical uuid FKs.
// No PHI / MBI is ever stored or audit-captured (D13, §3.6, §8.7).

// shared enums + jsonb payload helper types
export * from "./types";

// 17 owned tables (§3.3)
export * from "./claim";
export * from "./claim-line";
export * from "./claim-state-history";
export * from "./claim-submission";
export * from "./claim-acknowledgment";
export * from "./noe-record";
export * from "./notr-record";
export * from "./transfer-notice-record";
export * from "./clearinghouse-submission-attempt";
export * from "./dde-work-item";
export * from "./dde-work-event";
export * from "./per-diem-rate-calculation";
export * from "./sia-calculation";
export * from "./validation-rule-config";
export * from "./validation-run";
export * from "./validation-result";
export * from "./validation-override";
export * from "./sequestration-policy";
export * from "./hospice-rate-table";
export * from "./hospice-visit-charge-schedule";
export * from "./wage-index-factor";
export * from "./hospice-cbsa-reference";
export * from "./tenant-wage-index";
export * from "./mac-submitter-credential";
export * from "./eligibility-check";
export * from "./unmapped-taxonomy-occurrence";
