// apps/backend/src/modules/06-admission/seams/order-triggered-records-for-org.ts — GAP-032: M6's read for M11's
// `completion-watcher`. M11 orders that M6 acted on carry `source_order_id` on the M6 row they produced (F-223 on
// `election_period`, F-155 on `level_of_care_period`; logical uuids, M6's `dependsOn` excludes M11). The watcher asks,
// for a batch of ACTIVE `recertification` / `level_of_care_change` orders, which of them M6 already honoured — i.e. the
// order's "clinical intent has been fully discharged" (M11 §2.2 `completed`). Runs inside the caller's org tx.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray } from "drizzle-orm";

const EP = schema.electionPeriods;
const LCP = schema.levelOfCarePeriods;

export interface OrderTriggeredRecordIds {
  /** Order ids that produced an `active` / `completed` benefit period. */
  readonly recertOrderIds: ReadonlySet<string>;
  /** Order ids that produced a level-of-care period (`active` or `ended`; not one still `assigning`). */
  readonly locOrderIds: ReadonlySet<string>;
}

function idSet(rows: readonly { sourceOrderId: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.sourceOrderId) out.add(r.sourceOrderId);
  return out;
}

export async function orderTriggeredRecordsForOrg(
  tx: DbClient,
  organizationId: string,
  input: { readonly recertOrderIds: readonly string[]; readonly locOrderIds: readonly string[] },
): Promise<OrderTriggeredRecordIds> {
  const recert =
    input.recertOrderIds.length === 0
      ? []
      : await tx
          .select({ sourceOrderId: EP.sourceOrderId })
          .from(EP)
          .where(
            and(
              eq(EP.organizationId, organizationId),
              inArray(EP.sourceOrderId, [...input.recertOrderIds]),
              inArray(EP.status, ["active", "completed"]),
            ),
          );
  const loc =
    input.locOrderIds.length === 0
      ? []
      : await tx
          .select({ sourceOrderId: LCP.sourceOrderId })
          .from(LCP)
          .where(
            and(
              eq(LCP.organizationId, organizationId),
              inArray(LCP.sourceOrderId, [...input.locOrderIds]),
              inArray(LCP.status, ["active", "ended"]),
            ),
          );
  return { recertOrderIds: idSet(recert), locOrderIds: idSet(loc) };
}
