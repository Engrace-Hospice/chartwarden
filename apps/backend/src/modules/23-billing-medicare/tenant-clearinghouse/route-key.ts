// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/route-key.ts — the EDI-profile route of an organization:
// the vendor of its OWN live clearinghouse (`billing_edi_profile.route_key` is the vendor name), so the 837I submitter and
// receiver parties come from the profile the tenant entered for the vendor it actually sends through. Read on the CALLER'S
// transaction (the submit worker's), never a second pooled connection (see claim-837i-parties.ts).
import type { DbClient } from "@chartwarden/db";
import { createDrizzleConfigStore } from "./config-store";
import type { PlatformFallback } from "./service";

export function buildOrgRouteKeyReader(
  platformFallback: (organizationId: string) => PlatformFallback | null,
): (tx: DbClient, organizationId: string) => Promise<string | null> {
  return async (tx, organizationId) => {
    const row = await createDrizzleConfigStore(tx).find(organizationId);
    if (row) return row.status === "active" && row.vendor !== "outside" ? row.vendor : null;
    return platformFallback(organizationId)?.vendor ?? null;
  };
}
