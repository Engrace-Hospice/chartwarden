// apps/backend/src/modules/29-external-interfaces/outbound/order-dispatch-dedupe.ts — the ORDER-level dedupe
// question for outbound ORM dispatch (F-183, #248). READ-ONLY.
//
// WHY THIS EXISTS. M29 §2.6's dispatch dedup key is `hash(feed_id, source_aggregate_kind, source_aggregate_id)`
// (`outboundIdempotencyKey`). That key is right for "the same event redelivered to the same feed" and it is
// deliberately NOT changed here — it is spec-defined. But it hashes the feed the resolver picks AT DELIVERY TIME,
// and routing is mutable (an operator relinks a destination facility to another feed, swaps or deactivates a
// feed). The crash window is: the worker sent the ORM and committed its row, the process died before the
// dispatcher wrote the `(event, consumer)` receipt, the event is redelivered — and if routing changed in between,
// the redelivery resolves a DIFFERENT feed, computes a DIFFERENT key, finds nothing, and sends the same lab order
// to a second lab endpoint. The live proof is `m11-orm-duplicate-windows.live.test.ts` (W4).
//
// The invariant the key was reaching for is one ORM per ORDER, so this asks that question directly: is there any
// outbound row — on ANY feed, in ANY status (a crashed `in_flight`, a `dlq` terminal, a sent one) — for this order?
// A redelivery that finds one must send nothing: the row owns the order's MSH-10 and the reclaim sweep (F-182) is
// the only path allowed to re-send it. Runs on the caller's org-scoped transaction, so RLS applies.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray } from "drizzle-orm";
import { ORM_SOURCE_KIND } from "./dispatch-planner";

const HMO = schema.hl7MessageOutbound;

/**
 * The lookup itself, as an un-run query builder. Exported so the F-184 plan test can `EXPLAIN` EXACTLY this
 * statement (not a hand-copied one that could drift). Served by `idx_hmo_org_source_aggregate` (migration 0265):
 * equality on all three columns, in index order.
 */
export function ormDispatchLookupQuery(tx: DbClient, organizationId: string, orderId: string) {
  return tx
    .select({ id: HMO.id })
    .from(HMO)
    .where(
      and(
        eq(HMO.organizationId, organizationId),
        eq(HMO.sourceAggregateKind, ORM_SOURCE_KIND),
        eq(HMO.sourceAggregateId, orderId),
      ),
    )
    .limit(1);
}

/** The statuses that mean an outbound row still OWNS the order: a send is queued or under way, or the lab acked it. */
const ROW_STILL_OWNS_ORDER = ["queued", "in_flight", "acked"] as const;

/**
 * F-184 — the ONE sanctioned exception to "one ORM per order", for an operator-ATTESTED re-dispatch. True when the
 * order has an outbound row that is `queued` or `in_flight` (a send still owns the order) or `acked` (the lab has
 * it). Only when every prior row is a dead end — `dlq` (exhausted, or held for delivery verification), `naked`
 * (an `AR` structural reject) or `failed` — may an attested attempt add a new row, and only because a human has
 * told us (attested, audited) that the lab did NOT receive the earlier attempt. Runs on the caller's org-scoped
 * transaction, under the same per-order advisory lock as {@link ormDispatchExistsForOrder}.
 */
export async function ormDispatchHasLiveOrDeliveredRow(
  tx: DbClient,
  organizationId: string,
  orderId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: HMO.id })
    .from(HMO)
    .where(
      and(
        eq(HMO.organizationId, organizationId),
        eq(HMO.sourceAggregateKind, ORM_SOURCE_KIND),
        eq(HMO.sourceAggregateId, orderId),
        inArray(HMO.status, [...ROW_STILL_OWNS_ORDER]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** True when ANY outbound ORM row already exists for this order, whatever feed or status it has. */
export async function ormDispatchExistsForOrder(
  tx: DbClient,
  organizationId: string,
  orderId: string,
): Promise<boolean> {
  const rows = await ormDispatchLookupQuery(tx, organizationId, orderId);
  return rows.length > 0;
}

/** The transaction-scoped advisory-lock key that serializes every delivery for ONE order across ALL feeds. */
export function ormOrderDispatchLockKey(organizationId: string, orderId: string): string {
  return `m29.outbound.order:${organizationId}:${orderId}`;
}
