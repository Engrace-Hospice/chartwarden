// apps/backend/src/modules/37-ipu/routes/guards.ts — M37 §4.6/§4.7 route-guard builders (the M35
// routes/guards.ts precedent). `P` is the RBAC gate; `STEP_UP` the §D14 step-up assertion on the
// break-glass / attest mutations.
//
// §2.3 D3 RN-coverage note (TASK-050A/TEST-003 finding, fixed): this file used to also export
// `RN_COVERAGE`, a `requireAbac(key, "m37.ipu.rn_coverage_active", { getTarget: () => ({}) })` preHandler.
// `requireAbac`'s `getTarget` is SYNCHRONOUS (`packages/auth/src/abac/require-abac.ts`), so it can never
// query the materialized `ipu_rn_coverage_window` table the coverage fact actually lives in — the target
// was always `{}`, so the predicate (`(_c, t) => targetBool(t, "rnCoverageActive")`) always read `undefined`
// and denied every caller, unconditionally, on every route that composed it. Removed rather than left as a
// permissive no-op (which would be equally wrong but silently misleading instead of loudly broken).
// Enforcement now lives entirely in `routes/service-drizzle.ts`, where an async DB query inside the write
// transaction is legal — see `openAdmission`/`requestBed`/`initiateTransfer`/`applyRestraint`, each of which
// independently resolves the coverage window and throws the real `IPU_RN_COVERAGE_UNAVAILABLE` (412),
// `arranged` (remote-IPU) admissions exempt per §2.3. If a true preHandler-level ABAC gate on a materialized,
// periodically-recomputed fact like this is wanted again, it needs an async-capable `getTarget` (a core
// `requireAbac` change touching every one of M3's 168 predicates) or an in-process cache the
// `rn-coverage-watchdog` cron keeps warm — either is a real feature, not a bug fix, and neither exists today.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { ForbiddenError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M37 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §D14 step-up gate on the break-glass / attest / unit-deactivate mutations. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/**
 * §7.4 — GIP reassessment needs step-up ONLY when `criterion_still_met=false` (the LOC change is
 * consequential). A routine "still met" reassessment is not step-up gated. FAIL CLOSED: the step-up guard is
 * skipped only for a body whose `criterionStillMet` is exactly boolean `true`; false, missing or malformed
 * all run it. The service re-asserts the same rule and stores the real assertion id (second wall).
 */
export const STEP_UP_UNLESS_CRITERION_STILL_MET = (operationKey: string): PreHandler => {
  const stepUp = STEP_UP(operationKey);
  return async (request, reply) => {
    const body = request.body as { criterionStillMet?: unknown } | null | undefined;
    if (body?.criterionStillMet === true) return;
    await stepUp(request, reply);
  };
};

/**
 * GAP-106 — `m37.gip_criteria.attester_eligible` composed on the attest route (§4.6 note). The predicate
 * reads the actor's discipline off the server-assembled `AbacContext` roles; the target is ignored, so
 * nothing the client sends can make an RN eligible. A break-glass grant never stands in for an attestation.
 */
export const GIP_ATTESTER_ELIGIBLE: PreHandler = requireAbac(
  "m37.gip_criteria.attest",
  "m37.gip_criteria.attester_eligible",
  { getTarget: () => ({}), breakGlassBypassable: false },
) as PreHandler;

/** GAP-106 — refuses EVERY tenant session: the route it guards is driven by the platform, not by a user. */
export const SYSTEM_INTERNAL_ONLY: PreHandler = async () => {
  throw new ForbiddenError("system-internal route: not callable from a tenant session");
};
