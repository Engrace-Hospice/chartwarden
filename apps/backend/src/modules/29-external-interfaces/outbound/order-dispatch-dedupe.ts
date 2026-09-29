// apps/backend/src/modules/29-external-interfaces/outbound/order-dispatch-dedupe.ts — the ORDER-level dedupe
// question for outbound ORM dispatch (F-180, #248). READ-ONLY.
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
// A redelivery that finds one must send nothing: the row owns the order's MSH-10 and the reclaim sweep (F-179) is
// the only path allowed to re-send it. Runs on the caller's org-scoped transaction, so RLS applies.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
import { ORM_SOURCE_KIND } from "./dispatch-planner";

const HMO = schema.hl7MessageOutbound;

/** True when ANY outbound ORM row already exists for this order, whatever feed or status it has. */
export async function ormDispatchExistsForOrder(
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
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The transaction-scoped advisory-lock key that serializes every delivery for ONE order across ALL feeds. */
export function ormOrderDispatchLockKey(organizationId: string, orderId: string): string {
  return `m29.outbound.order:${organizationId}:${orderId}`;
}
