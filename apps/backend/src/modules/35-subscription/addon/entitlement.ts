// apps/backend/src/modules/35-subscription/addon/entitlement.ts — ADR-0108 the claims-billing entitlement.
//
// `decideClaimsBillingEntitlement` is the pure rule (D3): entitled iff the org holds a trialing/active, not-ended
// `subscription_addon` row for `claims_billing` AND the subscription that row hangs off is trialing, active, past_due
// or at_risk. A suspended / canceled / paused base subscription denies with its own reason even while the add-on row
// is live: the add-on rides on the subscription, it does not outlive it.
//
// `createDrizzleClaimsBillingEntitlementReader` reads it on the TENANT pool under `withOrgContext` (the
// `subscription_addon` SELECT-only policy is keyed on app.org_id). No cache (D4): a grant or cancel takes effect on
// the next request; the route gate memoises per request. A read failure THROWS, and new-work callers fail closed.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  CLAIMS_BILLING_ADDON_SLUG,
  type ClaimsBillingEntitlement,
  type ClaimsBillingEntitlementReader,
  type SubscriptionAddonStatus,
  type SubscriptionStatus,
} from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";

/** Base subscription statuses an add-on may ride on (dunning still lets work start; D3). */
export const ENTITLING_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "trialing",
  "active",
  "past_due",
  "at_risk",
]);

export interface AddonFacts {
  readonly status: SubscriptionAddonStatus;
  readonly trialEndsAt: Date | null;
  readonly endsAt: Date | null;
  /** Status of the subscription the add-on row belongs to. */
  readonly subscriptionStatus: SubscriptionStatus;
}

/** True while a trialing/active row has not reached its end (trial end or scheduled end). */
export function addonIsLive(row: Omit<AddonFacts, "subscriptionStatus">, now: Date): boolean {
  if (row.status === "canceled") return false;
  if (row.endsAt && row.endsAt <= now) return false;
  if (row.status === "trialing" && (!row.trialEndsAt || row.trialEndsAt <= now)) return false;
  return true;
}

/**
 * The D3 rule. `latest` is the org's most recent add-on row (any status), or null when it never held one.
 */
export function decideClaimsBillingEntitlement(
  latest: AddonFacts | null,
  now: Date,
): ClaimsBillingEntitlement {
  if (!latest) return { entitled: false, reason: "never_purchased" };
  if (!addonIsLive(latest, now)) return { entitled: false, reason: "lapsed" };
  switch (latest.subscriptionStatus) {
    case "suspended":
      return { entitled: false, reason: "subscription_suspended" };
    case "canceled":
      return { entitled: false, reason: "subscription_canceled" };
    case "paused":
      return { entitled: false, reason: "subscription_paused" };
    default:
      return ENTITLING_SUBSCRIPTION_STATUSES.has(latest.subscriptionStatus)
        ? { entitled: true }
        : { entitled: false, reason: "lapsed" };
  }
}

/** The org's most recent claims-billing add-on row joined to its subscription status (or null). */
export async function latestClaimsBillingAddon(
  tx: DbClient,
  organizationId: string,
): Promise<(AddonFacts & { readonly id: string; readonly startedAt: Date }) | null> {
  const SA = schema.subscriptionAddon;
  const A = schema.addonRow;
  const S = schema.subscriptionRow;
  const [row] = await tx
    .select({
      id: SA.id,
      status: SA.status,
      trialEndsAt: SA.trialEndsAt,
      endsAt: SA.endsAt,
      startedAt: SA.startedAt,
      subscriptionStatus: S.status,
    })
    .from(SA)
    .innerJoin(A, eq(A.id, SA.addonId))
    .innerJoin(S, eq(S.id, SA.subscriptionId))
    .where(and(eq(SA.organizationId, organizationId), eq(A.slug, CLAIMS_BILLING_ADDON_SLUG)))
    .orderBy(desc(SA.startedAt), desc(SA.createdAt))
    .limit(1);
  return row ? { ...row, subscriptionStatus: row.subscriptionStatus as SubscriptionStatus } : null;
}

export function createDrizzleClaimsBillingEntitlementReader(
  db: DbClient,
  now: () => Date = () => new Date(),
): ClaimsBillingEntitlementReader {
  return {
    async entitlementForOrg(organizationId) {
      const latest = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        latestClaimsBillingAddon(tx as unknown as DbClient, organizationId),
      );
      return decideClaimsBillingEntitlement(latest, now());
    },
  };
}
