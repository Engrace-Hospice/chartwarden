// apps/backend/src/modules/21-supplies/seams/delivered-source-orders-for-org.ts — GAP-032: M21's read for M11's
// `completion-watcher` net. M11 `supply` / `comfort_kit` orders complete on M21 delivery (M11 D8: the
// `m21-fulfillment-status` consumer is the primary path); this answers, for a batch of ACTIVE order ids, which already
// have a delivered / confirmed / completed supply request (`source_order_id`, logical uuid), so an order whose delivery
// event was missed still completes. Runs inside the caller's org tx.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

const REQUEST = schema.supplyRequest;

const DELIVERED_STATUSES = ["delivered", "received_confirmed", "completed"] as const;

export async function deliveredSourceOrderIdsForOrg(
  tx: DbClient,
  organizationId: string,
  orderIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await tx
    .select({ sourceOrderId: REQUEST.sourceOrderId })
    .from(REQUEST)
    .where(
      and(
        eq(REQUEST.organizationId, organizationId),
        inArray(REQUEST.sourceOrderId, [...orderIds]),
        inArray(REQUEST.status, [...DELIVERED_STATUSES]),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) if (r.sourceOrderId) out.add(r.sourceOrderId);
  return out;
}
