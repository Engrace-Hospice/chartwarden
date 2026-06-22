// apps/backend/src/modules/40-mdm/erasers/mdm-eraser.ts — M40-T10 the `mdm_tenant_overlays` data
// eraser (M40 spec §7.8, D7 tenant offboarding).
//
// M40 owns the destruction path for its tenant-attributable data — a tenant's overlay rows, all
// `mdm_provisional` rows, and all `mdm_baa_record` rows — so it registers the REAL eraser over the
// Phase-0 deny-stub (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root invokes
// registerMdmErasers() through buildServer's `registerModuleErasers` hook, which runs AFTER
// wireErasers() and before validateErasers(), so the real eraser stands and a tenant-offboarding
// request hits a working eraser, not a silent no-op (mirrors the M2/M4/M38/M36 erasers).
//
// The actual deletion is the pure `eraseTenantMdm` (packages/mdm/src/destruction): it deletes the
// org's overlay/provisional/baa rows and NOTHING else — the org-less CANONICAL entities
// (physician/facility/payer) are shared registry-sourced reference data that survive the tenant and
// are physically out of reach (the tenant role has no canonical write grant, M40-T03). Runs over an
// injected store with an in-memory default; production injects the Drizzle-backed store.
import { type MdmEraseStore, createInMemoryMdmEraseStore, eraseTenantMdm } from "@wardenx/mdm";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for the M40 eraser (slice defaults to the in-memory erase store). */
export interface MdmEraserDeps {
  /** The data port deletes run over (Drizzle-backed in production; in-memory by default). */
  store?: MdmEraseStore;
}

/**
 * Build M40's `mdm_tenant_overlays` DataEraser. The destruction registry hands `subjectId` = the
 * offboarding org id; the eraser deletes that org's overlay/provisional/baa rows and reports the
 * faithful total removed (0 when the org never created any). The per-class counts the destruction
 * certificate records are computed by the pure `eraseTenantMdm`.
 */
export function createMdmEraser(store: MdmEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      // The data class is org-scoped: both `scope.orgId` and the offboarding `subjectId` name the
      // org. Erase by the subject (the offboarding org), consistent with the M2/M4/M38 erasers.
      void scope;
      const { erased } = await eraseTenantMdm(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register M40's REAL `mdm_tenant_overlays` eraser into the M1 destruction-cert registry over the
 * Phase-0 deny-stub (M40-T10). Called by the composition root's wireModuleErasers() AFTER
 * wireErasers() and before validateErasers(), so the real eraser stands.
 */
export function registerMdmErasers(deps: MdmEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryMdmEraseStore().store;
  registerEraser("mdm_tenant_overlays", createMdmEraser(store));
}
