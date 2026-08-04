// apps/backend/src/modules/16-bereavement/routes/guards.ts — M16-T06 (§4.7 / §4.8) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M16 route
// plugin composes (the M15/M23/M24/M26 routes/guards.ts precedent). The §4.8 predicates resolve their
// subject facts server-side from the route's path param, mapped onto the ABAC target — never from a
// caller-supplied org/actor claim. The §4.1 "step_up_fresh" column composes `requireStepUp(<key>)` so M3
// resolves the per-operation freshness policy (the close-early / cosign-close routes).
//
// TWO composition rules the §4.1 table forces, both of which are easy to get exactly backwards:
//
//   1. `A ∨ B` IS NOT TWO GUARDS. Fastify preHandlers compose by AND, so binding `bereavement_window` and
//      `org_scope_bereavement_oversight` as two guards would REQUIRE both — strictly stricter than the
//      table, and it would lock a supervisor out of a plan they do not personally hold. Every §4.1 row
//      that reads `bereavement_window ∨ org_scope_bereavement_oversight` is satisfied by the single
//      `bereavement_window` predicate, because §4.8 already writes oversight in as a DISJUNCT of it.
//      Where the alternative is genuinely a different predicate (routes 14 / 15's portal-self branch),
//      {@link ABAC_ANY} runs them in order and allows on the first that passes.
//   2. `bereavement_window` is pinned to plan status ∈ {active, paused}. The three PRE-ACTIVE routes
//      (3 assign-counselor, 4 assign-volunteer, 5 seed-roster-and-schedule) address a plan that is
//      `eligible` or `initiating` by definition, so binding the window predicate there would 403 forever
//      — the same class of dead-gate bug M15 hit binding M7's `caseload_or_scope` on an M15 plan id.
//      §4.1's own ABAC column agrees for 3 and 4 (`org_scope_bereavement_oversight ∧ …`); route 5's
//      `bereavement_window` cell is the spec contradicting its own §4.8 definition, and §4.8 (the
//      predicate's definition) wins, so route 5 binds oversight.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { ForbiddenError, NotFoundError } from "@wardenx/types";
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

/** RBAC gate — `requirePermission(key)` from M3 (the §4.7 key catalog M16 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/**
 * §4.8 `bereavement_window` over the route's `:planId`. `notFoundOnDeny` keeps a plan a caller may not
 * touch indistinguishable from one that does not exist — the 404 leaks nothing about which patients died.
 */
export const ABAC_WINDOW_PLAN = (key: string): PreHandler =>
  requireAbac(key, "bereavement_window", {
    getTarget: (r) => ({ planId: param(r, "planId") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 `bereavement_window` resolved through the route's `:contactId` (routes 12–18, 26, 32). */
export const ABAC_WINDOW_CONTACT = (key: string): PreHandler =>
  requireAbac(key, "bereavement_window", {
    getTarget: (r) => ({ contactId: param(r, "contactId") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 `bereavement_window` resolved through the route's `:outreachId` (routes 20–25). */
export const ABAC_WINDOW_OUTREACH = (key: string): PreHandler =>
  requireAbac(key, "bereavement_window", {
    getTarget: (r) => ({ outreachId: param(r, "outreachId") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 `org_scope_bereavement_oversight` — no subject to resolve; the caller's role set decides. */
export const ABAC_OVERSIGHT = (key: string): PreHandler =>
  requireAbac(key, "org_scope_bereavement_oversight", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.8 `discipline_can_provide_bereavement` about the CALLER (routes 18, 30 — §4.1 writes them `(self)`).
 * The predicate falls back to the acting membership when the target names no subject.
 */
export const ABAC_DISCIPLINE_SELF = (key: string): PreHandler =>
  requireAbac(key, "discipline_can_provide_bereavement", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 route 3 — `discipline_can_provide_bereavement(target)` about the ASSIGNEE named in the body. The
 * §2.2 machine re-checks the same fact (`counselorCanProvideBereavement`) inside the transaction, so a
 * request that slipped past the guard on a stale grant still cannot land an ineligible counselor.
 */
export const ABAC_DISCIPLINE_COUNSELOR = (key: string): PreHandler =>
  requireAbac(key, "discipline_can_provide_bereavement", {
    getTarget: (r) => ({ counselorUserId: bodyField(r, "counselorUserId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 route 4 — `volunteer_gates_satisfied(target)`. §4.8 makes that check a CLAUSE of
 * `discipline_can_provide_bereavement` (satisfied only for the `bereavement_volunteer` discipline, and
 * only when M15's 418.78 gates are all clear), so the volunteer branch of that one predicate IS the §4.1
 * cell. Registering a second predicate name for the same fact would let a future route bind whichever of
 * the two happened to be stale.
 */
export const ABAC_VOLUNTEER_GATES = (key: string): PreHandler =>
  requireAbac(key, "discipline_can_provide_bereavement", {
    getTarget: (r) => ({ volunteerUserId: bodyField(r, "volunteerUserId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.8 `portal_self_service` over the route's `:contactId` (the bereaved person's own M31 session). */
export const ABAC_PORTAL_SELF = (key: string): PreHandler =>
  requireAbac(key, "portal_self_service", {
    getTarget: (r) => ({ contactId: param(r, "contactId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * Compose the §4.1 `∨` rows: run each guard in order and ALLOW on the first that passes; re-raise the LAST
 * guard's rejection when every branch denies. Only authorization rejections (`ForbiddenError` /
 * `NotFoundError`) fall through to the next branch — a 401, a 500 or a validation error propagates
 * immediately, so a broken predicate cannot be laundered into "try the other one" and quietly pass.
 */
export function ABAC_ANY(...guards: readonly PreHandler[]): PreHandler {
  return async (request, reply) => {
    let lastDenial: unknown;
    for (const guard of guards) {
      try {
        await guard(request, reply);
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenError) && !(error instanceof NotFoundError)) throw error;
        lastDenial = error;
      }
    }
    throw lastDenial ?? new ForbiddenError("no authorization branch permitted this request");
  };
}

/** §4.1 "step_up_fresh" — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;
