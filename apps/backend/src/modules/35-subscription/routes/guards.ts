// apps/backend/src/modules/35-subscription/routes/guards.ts — M35 (§4.7 / §4.8) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` / `requireIdempotencyKey` preHandler
// factories every M35 route plugin composes (the M27 routes/guards.ts precedent). Each is cast to the
// local {@link PreHandler} (a @wardenx/auth `GuardHandler` is structurally a Fastify preHandler). M35
// carries NO PHI (§8.5); the gates here are RBAC + the §4.8 scope/step-up ABAC chain + the §D14 step-up
// assertion on the financial / platform mutations.
//
// ABAC COMPOSITION (§4.8): `billing_scope_matches_org` confines the tenant surface to the caller's own org
// (the target is left empty — the tenant routes operate only on the caller's org, which the predicate
// treats as implied). `platform_billing_scope` gates the /api/admin surface on a platform-ops role.
// `refund_requires_step_up_approval` gates refund approval on a FRESH step-up (the four-eyes clause is
// re-asserted by the write service against the loaded refund row, which carries the requester the guard
// cannot cheaply resolve). The remaining two §4.8 predicates — `plan_change_within_period_grace` and
// `promo_applicable_to_subscription` — need DB-resident resource facts (a subscription's current period,
// a promo's redemption count) the guard layer cannot supply; they are REGISTERED (./abac-predicates) and
// named in the §4.7 permission catalog, and the write service enforces the same invariants server-side.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { PreHandler } from "./actor";
import { requireIdempotencyKey } from "./concurrency";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.7 key catalog M35 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.8 `billing_scope_matches_org` — confines a tenant mutation to the caller's own org. */
export const BILLING_SCOPE = (key: string): PreHandler =>
  requireAbac(key, "billing_scope_matches_org", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.8 `platform_billing_scope` — the /api/admin surface gate (a platform-ops billing role). */
export const PLATFORM_SCOPE = (key: string): PreHandler =>
  requireAbac(key, "platform_billing_scope", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.8 `refund_requires_step_up_approval` — refund approval needs a fresh step-up (four-eyes in service). */
export const REFUND_APPROVAL = (key: string): PreHandler =>
  requireAbac(key, "refund_requires_step_up_approval", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §D14 step-up gate — a thin `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (the M27
 * `requireStepUp` precedent). Composed on the financial / platform mutations; the operation key is the
 * permission key so M3 resolves the per-op freshness policy.
 */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/** §4.17 Idempotency-Key presence guard (the 24h replay caching is the M1 global middleware). */
export const IDEMPOTENT: PreHandler = requireIdempotencyKey();
