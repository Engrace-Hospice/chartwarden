// @chartwarden/reporting · repositories barrel (M33 §3.3–§3.4).
//
// Eight Drizzle data ports over the twelve M33-owned tables. Each repo is a thin reader/writer that takes
// the Drizzle client (`ReportingDb` — pooled client or a `withOrgContext` / `withPlatformContext`
// transaction handle) in its constructor and issues plain Drizzle queries; the translator / dashboard /
// schedule / drilldown SERVICES (later phases) wrap each call in `withOrgContext` (org-scoped) or
// `withPlatformContext` (platform catalogs + the nullable-org MV-refresh ledger) so Postgres RLS scopes
// every statement — keeping tenant-scoping in one home.
//
//   ReportDefinitionRepository       — report_definition (+ optimistic lock) + report_definition_version
//   ReportViewRepository             — report_view (owner / pinned filters / share scope / org default)
//   ReportShareRepository            — report_share (role / membership share grants + revocation cascade)
//   ReportScheduleRepository         — report_schedule (cron-driven view render to a recipient list)
//   ReportRunRepository              — report_schedule_run + report_run (partitioned run ledgers)
//   ReportCatalogRepository          — report_base_catalog + report_metric_catalog + materialized_view_metadata
//   ReportDrilldownAuditRepository   — report_drilldown_audit (insert-only; compliance, destruction-blocked)
//   DashboardTileCacheRepository     — dashboard_tile_cache (transient sha256-keyed tile cache + TTL)
export type { ReportingDb } from "./db";
export { ReportDefinitionRepository } from "./definitions";
export { ReportViewRepository } from "./views";
export { ReportShareRepository } from "./shares";
export { ReportScheduleRepository } from "./schedules";
export { ReportRunRepository } from "./runs";
export { ReportCatalogRepository } from "./catalogs";
export { ReportDrilldownAuditRepository } from "./drilldown-audit";
export { DashboardTileCacheRepository } from "./tile-cache";
