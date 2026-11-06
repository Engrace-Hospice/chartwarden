// apps/backend/src/modules/24-billing-medicaid/void-claim.ts — ADR-0108: a void successor (TOB 818, see
// `buildSuccessorClaim`) stays transmittable without the claims-billing add-on. The submit route and the
// medicaid-claim.submit / retry workers ask this before refusing or holding. The TOB is read from the stored claim
// under the org's RLS context, never taken from the request.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

export const VOID_TOB = "818";

/** True when the org's Medicaid claim `claimId` is a void. An empty user id inherits the request actor (or none). */
export async function isVoidM24Claim(
  db: DbClient,
  organizationId: string,
  claimId: string,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await tx
      .select({ tob: schema.medicaidClaim.tob })
      .from(schema.medicaidClaim)
      .where(eq(schema.medicaidClaim.id, claimId))
      .limit(1);
    return row?.tob === VOID_TOB;
  });
}
