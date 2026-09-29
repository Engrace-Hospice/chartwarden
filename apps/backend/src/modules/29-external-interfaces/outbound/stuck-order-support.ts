// apps/backend/src/modules/29-external-interfaces/outbound/stuck-order-support.ts — the two M29 facts M11's stuck-order
// recovery needs and cannot read itself (M11 has no `dependsOn` edge to M29; the composition root injects these). F-198.
//
//   • `outboundBaaCleared`  — is the destination facility's BAA in force NOW? The producer does not check the BAA (this
//     module's worker does, at dispatch), so an automatic retry of a `dispatch_refused:baa_inactive` order must ask the
//     SAME gate before it re-emits; otherwise a still-lapsed BAA round-trips through the worker and re-alerts the
//     ordering provider on every attempt. It is the worker's own resolver + decision, composed — never a second copy of
//     the gate — and it FAILS CLOSED exactly as the worker does (`resolveOutboundBaaResult`: any seam error, unregistered
//     seam or unresolved facility reads as "not in force").
//   • `ormOutboundFeedsForOrders` — which feed each order's outbound message went to, for the held-order worklist.
//     READ-ONLY, on the caller's org-scoped transaction (RLS applies; the read is also explicitly org-filtered).
import { type DbClient, schema } from "@wardenx/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { decideBaaGate } from "../feed/baa-gate";
import { ORM_SOURCE_KIND } from "./dispatch-planner";
import { resolveOutboundBaaResult } from "./resolve-baa";

const HMO = schema.hl7MessageOutbound;

/** True only when the D16 BAA gate ALLOWS an outbound ORM to `destinationFacilityId` as of `asOf`. */
export async function outboundBaaCleared(input: {
  readonly organizationId: string;
  readonly destinationFacilityId: string;
  readonly asOf: Date;
}): Promise<boolean> {
  const result = await resolveOutboundBaaResult({
    organizationId: input.organizationId,
    destinationFacilityId: input.destinationFacilityId,
    asOf: input.asOf,
  });
  return decideBaaGate(result).allowed;
}

/**
 * order id → the feed of its MOST RECENT outbound row (any status). An order with no outbound row is absent from the
 * map. The newest row wins: a held order's dead-ended attempt is the one an operator is asking about, and an attested
 * re-dispatch (F-187) adds a newer row on the same or another feed.
 */
export async function ormOutboundFeedsForOrders(
  tx: DbClient,
  organizationId: string,
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const feeds = new Map<string, string>();
  if (orderIds.length === 0) return feeds;
  const rows = await tx
    .select({ orderId: HMO.sourceAggregateId, feedId: HMO.feedId })
    .from(HMO)
    .where(
      and(
        eq(HMO.organizationId, organizationId),
        eq(HMO.sourceAggregateKind, ORM_SOURCE_KIND),
        inArray(HMO.sourceAggregateId, [...orderIds]),
      ),
    )
    .orderBy(desc(HMO.queuedAt));
  for (const row of rows) {
    if (!feeds.has(row.orderId)) feeds.set(row.orderId, row.feedId);
  }
  return feeds;
}
