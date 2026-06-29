// apps/backend/src/modules/26-cap/routes/guards.ts — M26 (§4.6 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M26 route
// plugin composes (the M25/M27 routes/guards.ts precedent). The §4.7 predicates resolve their facts
// server-side from the route's `:periodId` (mapped onto the `capPeriodId` ABAC target). The §D12 step-up
// gate composes on methodology-lock / settlement-finalize / year-reopen (the operation key is the
// permission key so M3 resolves the per-op freshness policy).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { type PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown };

/** Map the route's `:periodId` path-param onto the `capPeriodId` ABAC target. */
const targetCapPeriodId = (request: TargetRequest): Record<string, unknown> => {
  const params = request.params as { periodId?: string } | undefined;
  return { capPeriodId: params?.periodId ?? "" };
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M26 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.7 ABAC over the route's `:periodId` cap period (named predicate, fail-closed). */
export const ABAC = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: targetCapPeriodId,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 ABAC with no period target (the platform-admin axis). */
export const ABAC_NO_TARGET = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;

/** §D12 step-up gate — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;
