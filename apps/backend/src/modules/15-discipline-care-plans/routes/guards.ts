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
// The §4.1 `caseload_or_scope` column is bound on every plan-bearing WRITE route via `planCaseloadScope`
// (GAP-046): `requirePermission` never reads `PermissionDef.abac`, so the route composes the shared
// predicate itself over the plan's patient. M15's `:planId` is a DISCIPLINE plan id M7's own resolver cannot
// resolve, hence the patient is resolved through the write service first. Reads narrow in the read service
// (`./disclosure.ts` `actorMayReadPatient`); the discipline-scope rule lives in
// `../lifecycle/validation`; the signer-role binding (the claimed `signerRole` must be held by the
// authenticated actor, one membership per slot) is enforced in the write service's `signVersion`
// (GAP-045), NOT here — no route guard reads the body's `signerRole`; the M39 consent gates in `./disclosure.ts`. See `../abac-predicates.ts`.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { type M15ReadActor, type PreHandler, actorOf } from "./actor";

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

/** Break-glass is read-only: every guard on a mutating route opts out of the emergency-grant bypass. */
const WRITE_ONLY = { breakGlassBypassable: false } as const;

/** Sentinel patient for a plan that cannot be resolved: it is on no caseload, so the scope guard denies. */
const UNRESOLVED_PATIENT = "00000000-0000-0000-0000-000000000000";

/** Resolves a plan's patient (org-scoped); `null` when the plan is absent / cross-tenant. */
export type PlanPatientResolver = (actor: M15ReadActor, planId: string) => Promise<string | null>;

/**
 * GAP-046 — the shared `caseload_or_scope` gate over a plan-bearing WRITE route. `requireAbac`'s `getTarget`
 * is synchronous, so a resolver guard first loads the `:planId`'s patient into a per-request slot, then the
 * predicate runs over `{ patientId }` with `notFoundOnDeny` (off-caseload is indistinguishable from absent).
 * Org-wide scope roles are exempt inside the predicate; an unknown plan resolves to a patient nobody covers
 * (404, never an allow); break-glass never opens a write. Compose it right after the RBAC gate.
 */
export function planCaseloadScope(key: string, resolve: PlanPatientResolver): PreHandler[] {
  const resolved = new WeakMap<object, string>();
  const resolveGuard: PreHandler = async (request) => {
    const patientId = await resolve(actorOf(request), param(request, "planId"));
    resolved.set(request, patientId ?? UNRESOLVED_PATIENT);
  };
  const scopeGuard = requireAbac(key, "caseload_or_scope", {
    getTarget: (request) => ({ patientId: resolved.get(request) ?? UNRESOLVED_PATIENT }),
    notFoundOnDeny: true,
    ...WRITE_ONLY,
  }) as PreHandler;
  return [resolveGuard, scopeGuard];
}

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
    ...WRITE_ONLY,
  }) as PreHandler;

/** §4.5 `volunteer_compliance_active` over the body's `volunteerMembershipId` (route 17, §7.4). */
export const ABAC_VOLUNTEER_ACTIVE = (key: string): PreHandler =>
  requireAbac(key, "volunteer_compliance_active", {
    getTarget: (r) => ({ volunteerMembershipId: bodyField(r, "volunteerMembershipId") }),
    notFoundOnDeny: false,
    ...WRITE_ONLY,
  }) as PreHandler;

/** §4.5 `volunteer_coordinator_role` — no subject to resolve; the caller's role set decides. */
export const ABAC_COORDINATOR = (key: string): PreHandler =>
  requireAbac(key, "volunteer_coordinator_role", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
    ...WRITE_ONLY,
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
