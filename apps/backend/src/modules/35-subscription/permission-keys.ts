// apps/backend/src/modules/35-subscription/permission-keys.ts — M35 (§4.7 / §6).
//
// The twenty-six permission keys Module 35 (Subscription Billing) registers into Module 3's catalog —
// the §4.7 cross-module handshake (mirrored from `M35_CONTRIBUTED_PERMISSIONS` in `@chartwarden/auth`). M3 must
// include these before M35's subscription / payment-method / invoice / usage (tenant) and plan / refund /
// promo / revenue / dunning / stripe (platform-ops) routes can be authorized; every route gates on
// `requirePermission(key)`. The catalog `abac` field is the DEFAULT predicate per key; the route layer
// additionally composes the explicit §4.8 chain M35 owns (./abac-predicates) over the M3-base `inOrg` and
// the §D14 step-up assertion on the mutating platform actions.
//
// REGISTRATION: `M35_CONTRIBUTED_PERMISSIONS` is declared compile-time in `@chartwarden/auth`'s
// `contributed.ts` (`satisfies Record<string, PermissionDef>`) and surfaced by `allPermissionMirrorRows()`
// (the M28 / M31 precedent) — there is no runtime `declare()` call. This file re-exports the map + the
// ordered key list the route inventory is asserted equal to in test.
import { type M35ContributedPermissionKey, M35_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";

export { M35_CONTRIBUTED_PERMISSIONS, type M35ContributedPermissionKey };

/** The ordered §4.7 key list (kept in lock-step with the §4.1/§4.2 route inventory — asserted in test). */
export const M35_PERMISSION_KEY_LIST: readonly M35ContributedPermissionKey[] = Object.keys(
  M35_CONTRIBUTED_PERMISSIONS,
) as M35ContributedPermissionKey[];

/**
 * The §4.7 platform-ops mutating keys that additionally carry a §D14 `requireStepUp` assertion at the
 * route (plan write, subscription admin write, dunning override, refund request/approve, promo write/apply/
 * revoke, revenue recompute, stripe replay) plus the two tenant one-time/financial actions
 * (`subscription.create` / `subscription.update` / `subscription.cancel` / `payment_method.write`).
 */
export const M35_STEP_UP_PERMISSION_KEYS: readonly M35ContributedPermissionKey[] = [
  "subscription.create",
  "subscription.update",
  "subscription.cancel",
  "payment_method.write",
  "plan.admin.write",
  "subscription.admin.write",
  "dunning.admin.override",
  "refund.request",
  "refund.approve",
  "promo.admin.write",
  "promo.admin.apply",
  "promo.admin.revoke",
  "revenue.admin.write",
  "stripe.admin.replay",
];
