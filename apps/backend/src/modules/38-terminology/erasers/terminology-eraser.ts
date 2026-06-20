// apps/backend/src/modules/38-terminology/erasers/terminology-eraser.ts — M38-T10 the
// `terminology_tenant_extensions` data eraser (spec §11 D8).
//
// M38 owns the destruction path for its ONLY tenant-attributable data — a tenant's
// `value_set_tenant_extension` rows — so it registers the REAL eraser over the Phase-0 deny-stub
// (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root invokes
// registerTerminologyErasers() through buildServer's `registerModuleErasers` hook, which runs AFTER
// wireErasers() and before validateErasers(), so the real eraser stands and a tenant-offboarding /
// right-to-erasure request hits a working eraser, not a silent no-op (mirrors the M2 identity and
// M4 audit erasers).
//
// The actual deletion is the pure `eraseTenantTerminology` (packages/terminology/src/destruction):
// it deletes the org's extensions and NOTHING else — platform reference tables (code systems,
// concepts, value-set definitions, expansions, embeddings) survive the tenant and are physically
// out of reach (the tenant role has no write grant, §7.4). Like the rest of the slice it runs over
// an injected store with an in-memory default; production injects the Drizzle-backed store (the same
// `TerminologyStore` adapter the provider/routes use, which implements `eraseTenantExtensions`).
import {
  type TerminologyEraseStore,
  createInMemoryTerminologyStore,
  eraseTenantTerminology,
} from "@wardenx/terminology";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for the M38 eraser (slice defaults to the in-memory terminology store). */
export interface TerminologyEraserDeps {
  /** The data port deletes run over (Drizzle-backed in production; in-memory store by default). */
  store?: TerminologyEraseStore;
}

/**
 * Build M38's `terminology_tenant_extensions` DataEraser. The destruction registry hands `subjectId`
 * = the offboarding org id; the eraser deletes that org's value-set extensions and reports the
 * faithful count removed (0 when the org never extended a value set).
 */
export function createTerminologyEraser(store: TerminologyEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      // The data class is org-scoped: both `scope.orgId` and the offboarding `subjectId` name the
      // org. Erase by the subject (the offboarding org), consistent with the M2/M4 erasers.
      void scope;
      return eraseTenantTerminology(subjectId, store);
    },
  };
}

/**
 * Register M38's REAL `terminology_tenant_extensions` eraser into the M1 destruction-cert registry
 * over the Phase-0 deny-stub (M38-T10). Called by the composition root's wireModuleErasers() AFTER
 * wireErasers() and before validateErasers(), so the real eraser stands.
 */
export function registerTerminologyErasers(deps: TerminologyEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryTerminologyStore().store;
  registerEraser("terminology_tenant_extensions", createTerminologyEraser(store));
}
