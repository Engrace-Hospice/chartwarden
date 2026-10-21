// apps/backend/src/modules/27-cost-report/routes/guards.ts — M27 (§4.6 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M27 route
// plugin composes (the M30 routes/*.routes.ts precedent: a local `P(...)` RBAC wrapper + per-predicate
// ABAC wrappers + the `requireIdempotencyKey` presence guard). Each is cast to the local {@link PreHandler}
// (a @chartwarden/auth `GuardHandler` is structurally a Fastify preHandler). M27 carries NO PHI (D18); the
// gates here are RBAC + the §4.7 provider/approver/period-active ABAC chain + the §D14 step-up assertion.
//
// ABAC TARGETING (§4.7): the M27 predicates resolve their provider/state facts SERVER-SIDE from the
// cost-report id — `cost_report_editor_for_provider` / `cost_report_approver_for_provider` map the route's
// `:id` (or, for `create`, the body's `providerEntityId`) onto the predicate target, then M3-T07's
// registered resolver derives the report's ProviderEntity + lifecycle state. `notFoundOnDeny:true`
// realizes the §2.2 existence-non-leak rule (a denied object-level check returns 404, not 403).
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { PreHandler } from "./actor";

/** A structural request shape carrying the ABAC target sources (params/body); GuardRequest is assignable. */
type TargetRequest = { readonly params?: unknown; readonly body?: unknown };

/** Map the route's `:id` path-param onto the `costReportId` ABAC target the M27 predicates resolve against. */
const targetCostReportId = (request: TargetRequest): Record<string, unknown> => {
  const params = request.params as { id?: string } | undefined;
  return { costReportId: params?.id ?? "" };
};

/** Map the create body's `providerEntityId` onto the ABAC target (the create route has no `:id` yet). */
const targetProviderFromBody = (request: TargetRequest): Record<string, unknown> => {
  const body = request.body as { providerEntityId?: string } | undefined;
  return { providerEntityId: body?.providerEntityId ?? "" };
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M27 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.7 `cost_report_editor_for_provider` over the route's `:id` — guards every draft/populating edit surface. */
export const EDITOR_FOR_PROVIDER = (key: string): PreHandler =>
  requireAbac(key, "cost_report_editor_for_provider", {
    getTarget: targetCostReportId,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `cost_report_editor_for_provider` over the CREATE body's `providerEntityId`. */
export const EDITOR_FOR_PROVIDER_CREATE = (key: string): PreHandler =>
  requireAbac(key, "cost_report_editor_for_provider", {
    getTarget: targetProviderFromBody,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `cost_report_approver_for_provider` — guards override / approve / submit / submit-past-deadline / reopen. */
export const APPROVER_FOR_PROVIDER = (key: string): PreHandler =>
  requireAbac(key, "cost_report_approver_for_provider", {
    getTarget: targetCostReportId,
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.7 `cost_report_period_active` — the state-machine ABAC (report in draft/populating) for input writes. */
export const PERIOD_ACTIVE = (key: string): PreHandler =>
  requireAbac(key, "cost_report_period_active", {
    getTarget: targetCostReportId,
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §D14 step-up gate — a thin `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (the M30
 * SRA `requireStepUp("sra.close")` precedent). Composed on override / approve / submit / submit-past-
 * deadline / reopen; the operation key is the permission key so M3-T07 resolves the per-op freshness policy.
 */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
