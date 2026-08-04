// apps/backend/src/modules/15-discipline-care-plans/routes/guards.ts — M15-T06 (§4.4 / §4.5) route-guard
// builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M15 route
// plugin composes (the M23/M24/M26 routes/guards.ts precedent). The §4.5 predicates resolve their subject
// facts server-side from the route's path param or body field, mapped onto the ABAC target — never from a
// caller-supplied org/actor claim. The §4.1 "session (step-up)" column composes `requireStepUp(<key>)` so
// M3 resolves the per-operation freshness policy (the plan-sign / assessment-sign / assessment-amend /
// supervisory-sign routes).
//
// The §4.1 inventory's SHARED predicates (`caseload_or_scope`, `discipline_scope`, `sud_disclosure_allowed`,
// `dpoa_active`, `signer_role_match`) are M7-owned and keyed on M7's own `planId`/`elementId` targets, which
// an M15 plan id cannot satisfy — binding them by name here would deny every M15 route permanently. M15
// enforces those gates in its own services over the same upstream facts (`./disclosure.ts` for the M39
// consent gates + the M5 caseload check; `../lifecycle/validation` for the discipline-scope and
// signer-role rules), which is the M9/M12/M13 posture. See `../abac-predicates.ts`.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { PreHandler } from "./actor";

type TargetRequest = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
};

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";
const bodyField = (request: TargetRequest, key: string): string => {
  const value = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
};
const queryField = (request: TargetRequest, key: string): string => {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.4 key catalog M15 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/**
 * §4.5 `aide_supervisor_eligible` over the route's `:planId` — the caller IS the plan's named supervising
 * RN, or a Clinical Supervisor / DON covering the plan's location. `notFoundOnDeny` keeps a plan a caller
 * may not touch indistinguishable from one that does not exist.
 */
export const ABAC_SUPERVISOR = (key: string): PreHandler =>
  requireAbac(key, "aide_supervisor_eligible", {
    getTarget: (r) => ({ planId: param(r, "planId") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.5 `volunteer_compliance_active` over the body's `volunteerMembershipId` (route 17, §7.4). */
export const ABAC_VOLUNTEER_ACTIVE = (key: string): PreHandler =>
  requireAbac(key, "volunteer_compliance_active", {
    getTarget: (r) => ({ volunteerMembershipId: bodyField(r, "volunteerMembershipId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.5 `volunteer_coordinator_role` — no subject to resolve; the caller's role set decides. */
export const ABAC_COORDINATOR = (key: string): PreHandler =>
  requireAbac(key, "volunteer_coordinator_role", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.5 / D9 `family_violence_disclosure_allowed` over the route's `:planId` (route 2's full-plan read).
 * A DENY here is NOT a 403: family-violence content is filtered from the body at the SQL level and the
 * response carries `redacted_categories` (§7.9) — so this guard is composed only where the ROUTE itself is
 * gated, and the read path uses `./disclosure.ts` for the per-row filter.
 */
export const ABAC_FAMILY_VIOLENCE = (key: string): PreHandler =>
  requireAbac(key, "family_violence_disclosure_allowed", {
    getTarget: (r) => ({ planId: param(r, "planId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.5 `volunteer_compliance_active` over a `volunteerMembershipId` query param (the seam read, route 27). */
export const ABAC_VOLUNTEER_ACTIVE_QUERY = (key: string): PreHandler =>
  requireAbac(key, "volunteer_compliance_active", {
    getTarget: (r) => ({ volunteerMembershipId: queryField(r, "volunteerMembershipId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * Route 17 (§7.4 / §8.6) — the gate predicate, SKIPPED when the request carries a documented override.
 * A blanket `requireAbac` here would 403 before the handler and make the audited override path (which
 * §8.6 requires to exist, with a ≥40-char reason and a `warn`-severity audit trail) unreachable. When an
 * override IS supplied the pure `decideCreateVolunteerAssignment` still enforces the reason floor and
 * records the failing gates, so skipping the guard never skips the rule.
 */
export const ABAC_VOLUNTEER_ACTIVE_UNLESS_OVERRIDE = (key: string): PreHandler => {
  const gate = ABAC_VOLUNTEER_ACTIVE(key);
  return async (request, reply) => {
    const override = bodyField(request as TargetRequest, "overrideReason");
    if (override.trim().length > 0) return;
    await gate(request, reply);
  };
};

/** §4.1 "session (step-up)" — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
