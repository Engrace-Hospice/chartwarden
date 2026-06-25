// @wardenx/saas-tenant-platform — the `TenantSubscriptionEntitlementReader` FORWARD seam (M34 §4.6, D15).
//
// The one seam M34 CONSUMES rather than publishes: the billing/subscription entitlements M35 will own
// (plan tiers, seat counts, feature entitlements). M35 is not yet locked, so per D15 this ships a
// DENY-STUB that resolves `{ kind: 'unavailable', reason: 'm35_not_yet_locked' }` — callers (the
// lifecycle/onboarding paths that want to gate on entitlements) get a typed "not available yet"
// answer rather than a thrown import or a fail-open `true`. When M35 lands it registers the real
// reader over this stub (the rich-seam deny-stub-proxy pattern: interface in the consuming package,
// the M1 registry holds the instance opaquely as `unknown`, a deny-stub default applies fail-closed
// until the owner registers — mirrors @wardenx/mdm's forward-seam convention).

/**
 * The entitlements M35 will resolve per tenant (§4.6). Forward-declared minimally here — M35 owns the
 * authoritative shape when it locks; M34 only needs the discriminated availability envelope today.
 */
export interface TenantEntitlements {
  readonly planTier: string;
  readonly seatLimit: number | null;
  /** Feature entitlement keys granted by the tenant's subscription. */
  readonly features: readonly string[];
}

/** The discriminated result of an entitlement read. `unavailable` is the D15 forward-state answer
 *  until M35 is locked; `available` carries the resolved {@link TenantEntitlements} once it is. */
export type TenantEntitlementResult =
  | { readonly kind: "available"; readonly entitlements: TenantEntitlements }
  | { readonly kind: "unavailable"; readonly reason: "m35_not_yet_locked" };

/**
 * The forward seam M34 consumes from M35 (§4.6, D15). Deny-stub today — see
 * {@link denyStubTenantSubscriptionEntitlementReader}.
 */
export interface TenantSubscriptionEntitlementReader {
  entitlementsForOrg(orgId: string): Promise<TenantEntitlementResult>;
}

/**
 * The D15 deny-stub proxy. Returns `{ kind: 'unavailable', reason: 'm35_not_yet_locked' }` for every
 * org until M35 locks and registers the real reader over it. Consuming code branches on `kind` and
 * degrades cleanly (never fails open on entitlements). This is the value the M1 registry holds for
 * `TenantSubscriptionEntitlementReader` until M35 ships its implementation.
 */
export const denyStubTenantSubscriptionEntitlementReader: TenantSubscriptionEntitlementReader = {
  async entitlementsForOrg(_orgId: string): Promise<TenantEntitlementResult> {
    return { kind: "unavailable", reason: "m35_not_yet_locked" };
  },
};
