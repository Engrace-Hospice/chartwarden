// @wardenx/db — M27 Cost Report schema barrel (§3.3, 14 owned tables). Re-exported from the central
// schema barrel (../index.ts). Ordering follows FK dependency: the cost_report root, then its worksheet/
// snapshot/validation cluster, then the bad-debt/statistics/import/mapping/submission/compliance-window
// tables. NONE are partitioned (M27 is small in row-count). The RLS + grants + M4 write-audit triggers
// land in migrations 0070 / 0071; the enums + tables + FKs + indexes in 0069.
//
// Tenancy (ADR-0010, canonical): EVERY table carries organization_id, so the canonical app.org_id RLS
// predicate applies directly — EXCEPT cost_report_validation_rule whose organization_id is NULLABLE
// (platform-default rows, organization_id = NULL), declared on the check-tenancy NON_ORG_SCOPED
// allowlist with a platform-OR-org RLS policy (the M3 permission-catalog precedent). No PHI (D18).

// jsonb payload helper types.
export * from "./types";

// the cost_report root + its worksheet/snapshot/validation cluster
export * from "./cost-report";
export * from "./cost-report-worksheet";
export * from "./cost-report-snapshot";
export * from "./cost-report-validation";
export * from "./cost-report-validation-rule";
export * from "./cost-report-validation-result";
export * from "./cost-report-validation-override";

// bad-debt / statistics / imports / mapping / submission / compliance-window
export * from "./bad-debt-record";
export * from "./statistic-data";
export * from "./trial-balance-import";
export * from "./wage-data-import";
export * from "./cost-center-mapping";
export * from "./ecr-submission";
export * from "./cost-report-compliance-window";
