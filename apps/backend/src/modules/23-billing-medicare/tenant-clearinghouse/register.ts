// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/register.ts — M23's live seam registrations for the
// tenant clearinghouse (ADR-0053 amendment 2026-11-06), the sibling of M35's `seams/register.ts`.
//
// `TenantClearinghouseReader` (the org's choice) and `ClaimsBillingEntitlementReader` (the gate's decision over it) replace their
// throwing deny-stubs with the Drizzle readers on a db boot. A slice boot with no db keeps the stubs, and the claims-billing
// gate then fails CLOSED (boot refuses a non-`off` enforcement mode on an unbound seam).
import type { DbClient } from "@chartwarden/db";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createClaimsBillingEntitlementReader,
  createTenantClearinghouseReader,
  platformFallbackFromEnv,
} from "./choice";

export function registerM23TenantClearinghouseSeams(deps: {
  readonly db?: DbClient;
  readonly env: Readonly<Record<string, string | undefined>>;
}): void {
  if (!deps.db) return;
  const reader = createTenantClearinghouseReader({
    db: deps.db,
    platformFallback: platformFallbackFromEnv(deps.env).lookup,
  });
  registerSeam("TenantClearinghouseReader", reader);
  // The subscription seam (M35) resolves lazily, so registration order never matters; a stub that still throws makes the
  // entitlement read throw, and the gate fails closed.
  registerSeam(
    "ClaimsBillingEntitlementReader",
    createClaimsBillingEntitlementReader(reader, {
      blockForOrg: (organizationId) =>
        getSeam("SubscriptionWorkBlockReader").blockForOrg(organizationId),
    }),
  );
}
