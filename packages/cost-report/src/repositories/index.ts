// @wardenx/cost-report · repositories barrel (M27 §3.3).
//
// Twelve Drizzle data ports over the fourteen M27-owned tables. Each repo is a thin reader/writer that
// takes the Drizzle client (`CostReportDb` — the pooled client or a `withOrgContext` transaction handle)
// in its constructor and issues plain Drizzle queries; the read/write SERVICES (later phases) wrap each
// call in `withOrgContext` so Postgres RLS scopes every statement to `app.org_id` — keeping tenant-scoping
// in one home. No Fastify, no outbox, no `withOrgContext` here: pure data access. No PHI (D18); money is
// integer cents (D8).
//
//   CostReportRepository           — cost_report (root; §2.5 version-checked update → VERSION_CONFLICT)
//   CostReportWorksheetRepository  — cost_report_worksheet (21 worksheets; lazy-create + version-checked update)
//   CostReportSnapshotRepository   — cost_report_snapshot (insert-only; content-hash dedup; chain traversal)
//   ValidationRepository           — cost_report_validation + _result + _override (the validation-run cluster)
//   ValidationRuleRepository       — cost_report_validation_rule (platform-default + per-tenant layered)
//   BadDebtRepository              — bad_debt_record (opt-in; soft-delete tombstone for audit)
//   StatisticDataRepository        — statistic_data (one per report; seam-fan-in refresh)
//   ImportsRepository              — trial_balance_import + wage_data_import (append-only; latest-complete-pull)
//   CostCenterMappingRepository    — cost_center_mapping (per-(provider, FY); unmapped-account probe)
//   EcrSubmissionRepository        — ecr_submission (submission attempts; filing-status head)
//   ComplianceWindowRepository     — cost_report_compliance_window (filing-deadline tiers; cron scan)
export type { CostReportDb, VersionedUpdateResult } from "./db";
export { CostReportRepository } from "./cost-report";
export { CostReportWorksheetRepository } from "./worksheet";
export { CostReportSnapshotRepository } from "./snapshot";
export { ValidationRepository } from "./validation";
export { ValidationRuleRepository } from "./validation-rule";
export { BadDebtRepository } from "./bad-debt";
export { StatisticDataRepository } from "./statistic-data";
export { ImportsRepository } from "./imports";
export { CostCenterMappingRepository } from "./cost-center-mapping";
export { EcrSubmissionRepository } from "./ecr-submission";
export { ComplianceWindowRepository } from "./compliance-window";
