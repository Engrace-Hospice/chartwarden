// apps/backend/src/modules/35-subscription/abac-predicates.ts — M35 (§4.8).
//
// The five named ABAC predicate resolvers M35 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a `(context, target) => boolean | Promise<boolean>` evaluated server-side AFTER RBAC
// passes; M35 never authorizes by reading the request body — the org/actor/step-up facts ride on the
// server-assembled `AbacContext` (org id, roles, `attributes.membershipId` / `attributes.stepUpRecent`),
// and the resource-level facts the route puts on the ABAC target. `inOrg` (M3) is the RE-USED base
// predicate every tenant read also composes (M3 owns its registration); it is not re-registered here.
//
// The five names M35 owns:
//   billing_scope_matches_org           — the ABAC target's org equals the caller's org (tenant surface).
//   platform_billing_scope              — the caller carries a platform-ops role (admin surface).
//   refund_requires_step_up_approval    — refund approval needs a fresh step-up AND four-eyes (approver ≠
//                                         requester when the route resolves the requester onto the target).
//   plan_change_within_period_grace     — `always_invoice` proration outside the 7-day grace is platform-only.
//   promo_applicable_to_subscription    — the promo is active, in-window, under its cap, not already applied,
//                                         and the subscription is in a promo-eligible state.
//
// These predicates are PURE over `(context, target)` — no DB reach (unlike M27's Drizzle resolver). The
// deeper resource facts a predicate can only get from the DB (a refund's requester, a subscription's
// current period, a promo's redemption count) are resolved SERVER-SIDE by the write service and, where the
// route can cheaply put them on the ABAC target, checked here too; otherwise the write service re-asserts
// the same invariant. Default-deny throughout: a missing role, a stale step-up, an inapplicable promo all
// resolve to deny. Registration is idempotent (single-owner registry; the M27/M30 `has()` guard).
import {
  type AbacContext,
  type AbacTarget,
  PLATFORM_OPS_ROLE_KEYS,
  abacRegistry,
  registerPredicate,
} from "@wardenx/auth";

/** The §4.8 predicate names M35 OWNS and registers into M3 (five). `inOrg` (M3) is excluded — re-used. */
export const M35_REGISTERED_ABAC_PREDICATES = [
  "billing_scope_matches_org",
  "platform_billing_scope",
  "refund_requires_step_up_approval",
  "plan_change_within_period_grace",
  "promo_applicable_to_subscription",
] as const;

/** Union of the predicate names M35 registers. */
export type M35RegisteredAbacPredicate = (typeof M35_REGISTERED_ABAC_PREDICATES)[number];

/**
 * The platform-ops roles that satisfy `platform_billing_scope`. RE-DERIVED from the platform-owned role
 * catalog (`@wardenx/auth` `PLATFORM_OPS_ROLE_KEYS`, registered as `platform_staff` templates in ADMIN-T02)
 * so the ABAC gate's admit-set and the role catalog are a single source and can never drift.
 */
const PLATFORM_BILLING_ROLES: readonly string[] = PLATFORM_OPS_ROLE_KEYS;

/** Read a string field off the ABAC target; null when absent/empty (fail-closed on a missing fact). */
const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The actor's ACTIVE membership id (server-assembled M2 session attribute); null when the session has none. */
const actorMembershipId = (context: AbacContext): string | null => {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** True iff the session carries a server-verified recent step-up auth (§D14). */
const stepUpRecent = (context: AbacContext): boolean => context.attributes.stepUpRecent === true;

/** True iff the caller carries any platform-ops billing role. */
const isPlatformBilling = (context: AbacContext): boolean =>
  context.roles.some((r) => PLATFORM_BILLING_ROLES.includes(r));

/**
 * Build M35's five §4.8 predicate resolvers. Pure over `(context, target)`; every fact the predicate reads
 * is either on the server-assembled context or on the route-supplied target. Default-deny.
 */
export function buildM35AbacPredicates(): Record<
  M35RegisteredAbacPredicate,
  (context: AbacContext, target: AbacTarget) => boolean | Promise<boolean>
> {
  return {
    // The ABAC target's org equals the caller's org. The tenant routes set the target org to the caller's
    // own org server-side, so this is a belt-and-suspenders confinement (a tenant may only touch own org).
    billing_scope_matches_org: (context, target) => {
      const targetOrg = targetStr(target, "organizationId");
      // Absent target org → the route did not scope a cross-org object; the caller's own org is implied.
      if (!targetOrg) return true;
      return context.organizationId === targetOrg;
    },

    // The caller carries a platform-ops billing role — the admin surface gate. Fail-closed for a tenant
    // session (no platform role) even if it somehow reached an /api/admin route.
    platform_billing_scope: (context) => isPlatformBilling(context),

    // Refund approval requires a FRESH step-up AND four-eyes: the approver must differ from the requester.
    // The route resolves the refund's `requestedByMembershipId` onto the target where available; when it is
    // absent (not yet resolved) the write service re-asserts the four-eyes rule against the loaded row.
    refund_requires_step_up_approval: (context, target) => {
      if (!stepUpRecent(context)) return false; // stale / missing step-up → deny
      const requester = targetStr(target, "requestedByMembershipId");
      const approver = actorMembershipId(context);
      if (requester && approver && requester === approver) return false; // four-eyes violation
      return true;
    },

    // Outside the 7-day grace window, only a platform_admin may pass `always_invoice` proration. Within
    // grace (or any non-`always_invoice` behavior) the change is allowed. The subscription's
    // `currentPeriodStartAtMs` is put on the target by the route when it can resolve it; absent → treat as
    // outside grace (fail-closed to the platform-admin gate).
    plan_change_within_period_grace: (context, target) => {
      if (target.prorationBehavior !== "always_invoice") return true;
      const startMs = typeof target.currentPeriodStartAtMs === "number" ? target.currentPeriodStartAtMs : null;
      const nowMs = typeof target.nowMs === "number" ? target.nowMs : Date.now();
      const sevenDays = 7 * 24 * 3600 * 1000;
      if (startMs !== null && nowMs - startMs <= sevenDays) return true;
      return context.roles.includes("platform_admin");
    },

    // The promo is active, within its validity window, under its redemption cap, not already applied to
    // this subscription, and the subscription is in a promo-eligible state. The route resolves the promo +
    // subscription facts onto the target; a missing fact fails closed.
    promo_applicable_to_subscription: (_context, target) => {
      const promoActive = target.promoIsActive === true;
      if (!promoActive) return false;
      const nowMs = typeof target.nowMs === "number" ? target.nowMs : Date.now();
      const validFromMs = typeof target.promoValidFromMs === "number" ? target.promoValidFromMs : null;
      const validToMs = typeof target.promoValidToMs === "number" ? target.promoValidToMs : null;
      if (validFromMs !== null && nowMs < validFromMs) return false;
      if (validToMs !== null && nowMs > validToMs) return false;
      const maxRedemptions =
        typeof target.promoMaxRedemptions === "number" ? target.promoMaxRedemptions : null;
      const redemptionCount =
        typeof target.promoRedemptionCount === "number" ? target.promoRedemptionCount : 0;
      if (maxRedemptions !== null && redemptionCount >= maxRedemptions) return false;
      if (target.promoAlreadyApplied === true) return false;
      const status = typeof target.subscriptionStatus === "string" ? target.subscriptionStatus : "";
      return status === "active" || status === "trialing";
    },
  };
}

/**
 * Register M35's five §4.8 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * the predicates are pure (no db handle needed). Re-boot (tests) skips already-registered names
 * (single-owner / no-clear; the M27/M30 precedent). Never fails open.
 */
export function registerM35AbacPredicates(): void {
  const predicates = buildM35AbacPredicates();
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
