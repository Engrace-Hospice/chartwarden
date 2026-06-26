// apps/backend/src/modules/33-reporting/erasers/reporting-eraser.ts — the M33 `reporting_class` data eraser
// (M4 destruction registry, §3.7 / D6 / §8.4). On tenant offboarding M33's eraseFn deletes the org's
// OPERATIONAL reporting rows (report_schedule + the run ledgers, dashboard_tile_cache, report_view /
// report_share, report_definition / report_definition_version) in FK-safe order, REFUSES the compliance-class
// `report_drilldown_audit` (D9 survey-evidence — insert-only, destruction-blocked), and leaves the PLATFORM
// catalogs (report_base_catalog / report_metric_catalog / materialized_view_metadata) untouched (shared
// reference data, migration-retired only). Like M34, `subjectId` here is the ORG being offboarded (reporting
// has no patient subject), so the `DataEraser.erase(scope, subjectId)` bridge passes `subjectId` (the org)
// straight to the package's pure `eraseTenantReporting(orgId, store)`.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@wardenx/reporting` (eraser.ts);
// this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL eraser over the
// Phase-0 `reporting_class` deny-stub via the composition-root hook (after wireErasers(), before
// validateErasers() — the same M22/M34/M36/M40 registration shape).
import {
  type ReportingEraseStore,
  createInMemoryReportingEraseStore,
  eraseTenantReporting,
} from "@wardenx/reporting";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Deps for the M33 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface ReportingEraserDeps {
  /** The Drizzle-backed `ReportingEraseStore` in prod (each DELETE under the tenant/platform tenancy context);
   *  the in-memory slice store by default. */
  readonly store?: ReportingEraseStore;
}

/** Adapt the package's pure `eraseTenantReporting(orgId, store)` to the M1 `DataEraser` contract. */
export function createReportingEraser(store: ReportingEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this reporting class (no patient subject); the M4 destruction
    // registry hands it in as the subject the certificate records. The §3.7 co-sign gate (which needs the
    // destruction certificate's approver list) binds once the M4 cert-driven destruction binding lands.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantReporting(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M33 reporting eraser over the Phase-0 `reporting_class` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M34/M36/M40 use. The in-memory slice store is the default; prod injects the Drizzle store.
 *
 * TODO(M33 boot-wiring, P2C): inject the Drizzle-backed `ReportingEraseStore` (each DELETE for the operational
 * tables under the tenant offboarding tenancy context, `report_drilldown_audit` count-only) so the eraser runs
 * against the real M33 tables; this slice store removes the in-memory seed counts only. Wire the §3.7
 * `decisionCert` co-sign gate once the M4 cert-driven destruction binding lands.
 */
export function registerReportingErasers(deps: ReportingEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryReportingEraseStore().store;
  registerEraser("reporting_class", createReportingEraser(store));
}
