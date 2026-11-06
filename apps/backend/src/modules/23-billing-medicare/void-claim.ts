// apps/backend/src/modules/23-billing-medicare/void-claim.ts — ADR-0108: a void (TOB 818) stays transmittable without
// the claims-billing add-on. The submit route and the claim.submit / retry workers ask this before refusing or holding.
// The TOB is read from the stored claim under the org's RLS context, never taken from the request.
import { repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";

export const VOID_TOB = "818";

/** True when the org's claim `claimId` is a void. An empty user id inherits the request actor (or none in a worker). */
export async function isVoidM23Claim(
  db: repositories.BillingDb,
  organizationId: string,
  claimId: string,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const row = await new repositories.ClaimRepository(tx).findById(claimId);
    return row?.tob === VOID_TOB;
  });
}
