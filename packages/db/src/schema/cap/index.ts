// @wardenx/db — M26 Cap Management schema barrel (§3.3, 12 owned tables). Re-exports the shared enums plus
// every table module; the central ../index.ts re-exports this barrel.
//
// Tenancy (ADR-0010, canonical): 11 of the 12 tables carry organization_id NOT NULL → the canonical
// app.org_id RLS predicate applies directly. cap_period_platform_constant is PLATFORM-SHARED (no org
// column, like wage_index_factor / cost_report_validation_rule) — it is on the check-tenancy
// NON_ORG_SCOPED allowlist with read-all USING(true) + permission-gated writes (D3).
//
// Partitioning (§3.2): cap_beneficiary_accrual_line / cap_inpatient_day_line / cap_projection_snapshot are
// LIST-partitioned on cap_period_id. Drizzle carries logical shape only — composite PK (id, cap_period_id),
// LIST partition DDL + DEFAULT partition, RLS, grants, and M4 write-audit triggers land in SQL 0085-0090.
//
// CROSS-MODULE FK POLICY: cross-module FK constraints are FORBIDDEN. Only organization_id (core) +
// intra-M26 non-partitioned parents (cap_period, cap_psr_import) get real `.references(...)`. patient_id
// (M5), source_id (M23/M25), snapshot_id (partitioned sibling), *_by / step_up_session_id (M2), and
// cap_year (soft → cap_period_platform_constant) are LOGICAL uuid. No MBI value is audit-captured (D13).

// shared enums (13)
export * from "./enums";

// 12 owned tables (§3.3)
export * from "./cap-period"; // cap_period_platform_constant, cap_period, cap_period_methodology_lock
export * from "./accrual"; // cap_beneficiary_accrual, cap_beneficiary_accrual_line, cap_inpatient_accrual, cap_inpatient_day_line
export * from "./projection"; // cap_projection_snapshot, cap_threshold_event
export * from "./reconciliation"; // cap_psr_import, cap_psr_reconciliation, cap_settlement
