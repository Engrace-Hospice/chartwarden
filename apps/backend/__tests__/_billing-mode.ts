// A test oracle, not product code: the billing service mode IN FORCE on a day for an org's live contract (null without one), read on the
// tenant pool under the org's own scope, exactly as a tenant's own read would. The suites use it to prove what the writers did.
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { BillingServiceMode } from "@chartwarden/types";
import { utcDateOf } from "../src/modules/35-subscription/pricing/census-daily";
import { modeInForceOn } from "../src/modules/35-subscription/pricing/contract-mode";
import {
  loadModeHistory,
  selectNewestContract,
} from "../src/modules/35-subscription/pricing/contract-select";

export async function modeInForce(
  db: DbClient,
  organizationId: string,
  at: Date = new Date(),
): Promise<BillingServiceMode | null> {
  return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
    const record = await selectNewestContract(tx as never, "live", at, organizationId);
    if (!record) return null;
    const history =
      (await loadModeHistory(tx as never, [record.contract.id])).get(record.contract.id) ?? [];
    return modeInForceOn(history, utcDateOf(at));
  });
}
