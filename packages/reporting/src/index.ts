// @wardenx/reporting — Reporting & Dashboards (Module 33).
//
// Public surface of the package. M33 is the tenant-facing reporting plane: the whitelisted spec→SQL
// report-builder translator (D4 — no raw SQL surface), saved views / dashboards / tiles, scheduled
// reports + exports, and the drilldown emitter (D6 — aggregate-by-default; row-level PHI never leaves an
// M33 route). The Drizzle schema lives in the central barrel (packages/db/src/schema/reporting) per repo
// convention; this package holds the seams, the translator pipeline, repositories, and services that land
// in later M33 phases.
//
// First spine: the §4.3 PUBLISHED seam interfaces (MetricsProvider / DashboardCatalogProvider /
// ScheduledReportProvider), the §4.4 CONSUMED-seam consumer views + forward-seam deny-stubs, and the
// boot-time seam-registration hook (the P2C M1-registry wiring site). Translator / repositories /
// services land in later phases.
export * from "./seams";
export * from "./seam-registration";
// The §4.2 TypeBox schemas (report-definition spec / scheduled-report / tile-read).
export * from "./schemas";
// The §4 report-builder translator: the whitelisted spec→SQL pipeline (D4 — no raw-SQL surface).
export * from "./translator";
// The eight Drizzle data ports over the twelve M33-owned tables (§3.3–§3.4).
export * from "./repositories";
// The nine typed M36 alert payloads M33 emits (§4.9). File named `alert-defs` (mirroring the M34
// `alert-rules.ts` precedent) so the table-ownership check's crude token heuristic does not misread this
// barrel re-export as a reference to M36's Drizzle table — M33 imports no M36 schema, only TypeBox.
export * from "./alert-defs";
