// apps/backend/src/modules/23-billing-medicare/dde-aging-store.ts — the Drizzle store for the daily DDE aging alert (#767).
// Reads open `dde_work_item` rows on an org-scoped system transaction (RLS applies); ids, state, dates only.
import { repositories } from "@chartwarden/billing";
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { DdeAgingStore } from "./jobs/dde-aging-alert";

/** Most open items one org's alert reads per tick (oldest first). */
export const DDE_AGING_MAX_ITEMS_PER_ORG = 5000;

export function createDrizzleDdeAgingStore(db: DbClient): DdeAgingStore {
  return {
    listOpen: (organizationId) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const rows = await new repositories.DdeWorkItemRepository(
          tx as unknown as ConstructorParameters<typeof repositories.DdeWorkItemRepository>[0],
        ).listOpenForAging(DDE_AGING_MAX_ITEMS_PER_ORG);
        return rows.map((r) => ({
          id: r.id,
          state: r.state,
          deadlineAt: r.deadlineAt,
          openedOn: r.createdAt.toISOString().slice(0, 10),
          assigneeMembershipId: r.assigneeMembershipId,
        }));
      }),
  };
}
