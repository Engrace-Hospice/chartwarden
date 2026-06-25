// apps/backend/src/modules/34-saas-tenant-platform/erasers/saas-tenant-platform-eraser.ts — M34 the
// `saas_tenant_platform_class` data eraser (D6, §3.5/§8.4). On tenant offboarding M34's eraseFn deletes the
// org's operational control-plane working rows (onboarding tasks, support grants/sessions, BAA register,
// tenant invitations, signup intents/tokens, tenant-export jobs) and NOTHING ELSE — the lifecycle/key-ring
// destruction ledger and the §164.528 disclosure-accounting surfaces (`dsar_export_job`,
// `support_session_event`) SURVIVE. Unlike every patient-subject eraser, `subjectId` here is the ORG being
// offboarded (the platform control plane has no patient subject), so the `DataEraser.erase(scope, subjectId)`
// bridge below passes `subjectId` (the org) straight to the package's `eraseTenantSaasPlatform(orgId, store)`.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@wardenx/saas-tenant-platform`
// (eraser.ts); this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL
// eraser over the Phase-0 `saas_tenant_platform_class` deny-stub via the composition-root hook (the
// `saas_tenant_platform_class` data class is in REQUIRED_ERASERS, so wireErasers() deny-stubs it first and
// this real eraser stands over the stub before validateErasers() — the same M22/M36/M40 registration shape).
import {
  type SaasTenantPlatformEraseStore,
  createInMemorySaasTenantPlatformEraseStore,
  eraseTenantSaasPlatform,
} from "@wardenx/saas-tenant-platform";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Deps for the M34 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface SaasTenantPlatformEraserDeps {
  /** The Drizzle-backed `SaasTenantPlatformEraseStore` in prod (DELETEs under `withPlatformContext` so RLS
   *  scopes each statement); the in-memory slice store by default. */
  readonly store?: SaasTenantPlatformEraseStore;
}

/** Adapt the package's pure `eraseTenantSaasPlatform(orgId, store)` to the M1 `DataEraser` contract. */
export function createSaasTenantPlatformEraser(store: SaasTenantPlatformEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this control-plane class (no patient subject); the M4
    // destruction registry hands it in as the subject the certificate records.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantSaasPlatform(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M34 control-plane eraser over the Phase-0 `saas_tenant_platform_class` deny-stub. Called
 * by the composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the
 * same hook M5/M6/M22/M36/M40 use. The in-memory slice store is the default; prod injects the Drizzle store.
 *
 * TODO(Phase 2D): inject the Drizzle-backed `SaasTenantPlatformEraseStore` (every DELETE under
 * `withPlatformContext`) so the eraser runs against the real M34 tables; this slice store removes the
 * in-memory seed rows only. The package's `seam-bootstrap.ts` carries the matching TODO for registering this
 * eraseFn into M4's destruction-cert callback registry once the M4 cert-driven destruction binding lands.
 */
export function registerSaasTenantPlatformErasers(deps: SaasTenantPlatformEraserDeps = {}): void {
  const store = deps.store ?? createInMemorySaasTenantPlatformEraseStore().store;
  registerEraser("saas_tenant_platform_class", createSaasTenantPlatformEraser(store));
}
