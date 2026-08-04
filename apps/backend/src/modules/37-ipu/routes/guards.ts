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
import { requirePermission, requireStepUp } from "@wardenx/auth";
import type { PreHandler } from "./actor";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M37 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §D14 step-up gate on the break-glass / attest / unit-deactivate mutations. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
