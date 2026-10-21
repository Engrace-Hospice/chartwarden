// @chartwarden/reporting — Reporting & Dashboards (Module 33).
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
// The §4.5 platform-shipped data catalogs (the outbox-subscription map the incremental tier reads).
export * from "./catalog";
// The three-tier MV-refresh subsystem (§2.4–§2.6 / §4.8): PURE port-injected workers for the
// `report.mv_refresh` + `report.lag_probe` queues (the live BullMQ wiring binds at app boot in P2C).
export * from "./refresh";
// The read-replica session discipline (§8.1.2 / D3 / D14): `withReportSession` over an injected M1
// `read_replica_session` port (tiered statement_timeout + the D14 lag breaker → cache fallback).
export * from "./session";
// The scheduled-delivery subsystem (§2.2 / §2.5–§2.6 / §4.3 / §4.8 W-R-04 / D7): PURE port-injected handlers
// for the `report.scheduled_run` worker + the M22 render-reply delivery consumer (boot-wired in P2C).
export * from "./scheduled";
// The export subsystem (§4.8 / W-R-08 / D10): PURE port-injected handlers for the `report.export_render` /
// `report.export.csv` paths — the direct chunked CSV streamer (no M22 hop) + the PDF/XLSX M22 render-requests.
export * from "./export";
// The drilldown emitter (§5.1.3 / W-R-05 / §4.10 / D16): PURE port-injected handlers for `POST /drilldown/emit`
// — URL-template resolution + M39 consent narrowing (fail-closed) + the envelope-encrypted audit write.
export * from "./drilldown";
// The nine typed M36 alert payloads M33 emits (§4.9). File named `alert-defs` (mirroring the M34
// `alert-rules.ts` precedent) so the table-ownership check's crude token heuristic does not misread this
// barrel re-export as a reference to M36's Drizzle table — M33 imports no M36 schema, only TypeBox.
export * from "./alert-defs";
// The M4 destruction-registry eraseFn (§3.7 / D6 / §8.4): the pure tenant-offboarding sequence over an
// injected store + the in-memory store; the backend wrapper adapts it to the M1 `DataEraser` contract.
export * from "./eraser";
