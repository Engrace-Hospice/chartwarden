// apps/backend/src/modules/37-ipu/routes/guards.ts — M37 §4.6/§4.7 route-guard builders (the M35
// routes/guards.ts precedent). `P` is the RBAC gate; `STEP_UP` the §D14 step-up assertion on the
// break-glass / attest mutations; `RN_COVERAGE` composes the §4.7 `m37.ipu.rn_coverage_active` predicate on
// mutation routes (the write service also re-asserts the invariant inside the tx). The fine-grained
// resource facts (coverage window, IRC state) are resolved server-side onto the ABAC target by the service;
// the guard treats an absent fact as deny (fail-closed).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { PreHandler } from "./actor";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M37 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §D14 step-up gate on the break-glass / attest / unit-deactivate mutations. */
export const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;

/**
 * §4.7 `m37.ipu.rn_coverage_active` — the RN-coverage gate on IPU mutation routes. The write service resolves
 * the coverage fact onto the ABAC target; a missing fact fails closed. Unit-CRUD admin routes and arranged
 * remote-IPU routes carry an explicit exemption per §2.3 (they do not compose this guard).
 */
export const RN_COVERAGE = (key: string): PreHandler =>
  requireAbac(key, "m37.ipu.rn_coverage_active", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;
