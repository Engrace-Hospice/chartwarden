// apps/backend/src/modules/30-quality/erasers/quality-eraser.ts — the M30 `quality_class` data eraser
// (M4 destruction registry, §3.7 / D6 / §8.4). On tenant offboarding M30's eraseFn deletes the org's
// OPERATIONAL quality rows (measure_recompute_queue → quality_measure_value → cahps_decedent_sample →
// cahps_vendor_binding) in FK-safe order and REFUSES every COMPLIANCE-class survey evidence table
// (incident_report / mortality_review / the SRA chain / the QAPI chain / cop_compliance_status /
// infection surveillance / cahps_result_summary) — that evidence is the agency's record of having done
// the work (§418.58 / §418.60 / §164.308) and is destruction-blocked: counted for the certificate, never
// deleted. Like M33/M34, `subjectId` here is the ORG being offboarded (the tenant-offboarding cleanup has
// no patient subject), so the `DataEraser.erase(scope, subjectId)` bridge passes `subjectId` (the org)
// straight to the package's pure `eraseTenantQuality(orgId, store)`. The patient-scoped PHI redaction of
// the four partitioned PHI tables is a SEPARATE per-table eraser path (§3.7), not this offboarding eraseFn.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@wardenx/quality` (eraser.ts);
// this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL eraser over
// the Phase-0 deny-stub via the composition-root hook (after wireErasers(), before validateErasers() — the
// same M22/M33/M34/M36/M40 registration shape).
import {
  type QualityEraseStore,
  createInMemoryQualityEraseStore,
  eraseTenantQuality,
} from "@wardenx/quality";
import type { DataClass, DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/**
 * The M30 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned);
 * the Integrate phase adds `"quality_class"` to that union + to `REQUIRED_ERASERS`
 * (apps/backend/src/bootstrap/erasers/registry.ts) so boot fails closed if M30's real eraser is never
 * registered. Kept here as the single string literal so that wiring lands in one place.
 */
export const QUALITY_DATA_CLASS = "quality_class" as DataClass;

/** Deps for the M30 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface QualityEraserDeps {
  /** The Drizzle-backed `QualityEraseStore` in prod (each DELETE / COUNT under the offboarding tenancy
   *  context); the in-memory slice store by default. */
  readonly store?: QualityEraseStore;
}

/** Adapt the package's pure `eraseTenantQuality(orgId, store)` to the M1 `DataEraser` contract. */
export function createQualityEraser(store: QualityEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this quality class (no patient subject); the M4 destruction
    // registry hands it in as the subject the certificate records. The §3.7 co-sign gate (which needs the
    // destruction certificate's approver list) binds once the M4 cert-driven destruction binding lands.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantQuality(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M30 quality eraser over the Phase-0 `quality_class` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M33/M34/M36/M40 use. The in-memory slice store is the default; prod injects the Drizzle store.
 *
 * TODO(M30 boot-wiring, Integrate phase): (1) add `"quality_class"` to the `@wardenx/types` `DataClass`
 * union + `REQUIRED_ERASERS` so the deny-stub exists to register over; (2) inject the Drizzle-backed
 * `QualityEraseStore` (each operational DELETE + each compliance-class COUNT under the tenant-offboarding
 * tenancy context) so the eraser runs against the real M30 tables — this slice store removes the in-memory
 * seed counts only; (3) wire the §3.7 `decisionCert` co-sign gate once the M4 cert-driven destruction
 * binding lands. The four partitioned-PHI per-table erasers (patient-scoped redaction) register separately.
 */
export function registerQualityErasers(deps: QualityEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryQualityEraseStore().store;
  registerEraser(QUALITY_DATA_CLASS, createQualityEraser(store));
}
