// apps/backend/src/modules/11-orders/seams/drizzle-store.ts — the Drizzle overlay on M11's seam store.
//
// M11's seam store is the in-memory slice; this overlays the ONE read that needs real data today —
// the org-level verbal-order timeliness tally M30's `verbal_order_signature_on_time` measure consumes.
// The M8 `drizzle-store.ts` is the precedent: spread the in-memory store, override the live method, leave
// every other method on its slice default so no existing consumer regresses.
//
// Like the other live getSeam'd Drizzle reads, this SELF-SCOPES on `organizationId` via `withOrgContext` —
// its own pooled connection carries no ambient RLS context (the consumer's `withOrgContext` is on a
// different connection), and the explicit `organization_id` predicate is the second wall.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type OrderSeamStore, createInMemoryOrderSeamStore } from "./store";

const V = schema.verbalOrders;

/** The actor id the read's withOrgContext envelope carries — an aggregate read has no acting user. */
const ORDER_READER_SYSTEM_USER_ID = "";

/**
 * Build the production-overlay {@link OrderSeamStore}.
 *
 * `verbalTimelinessCountsForOrg` counts verbal orders RECEIVED in `[from, to)` and, of those, the ones
 * signed on or before their deadline. Two facts make this the honest denominator: the window keys on
 * `received_at` (not `signed_at`), so an order recorded in the window but never signed still counts
 * AGAINST timeliness rather than vanishing; and the numerator requires `signed_at <= deadline_at`, so a
 * late signature is not silently forgiven.
 *
 * Returns the PAIR, never a rate — M30's kernel suppresses a measure whose denominator is under the CMS
 * reportable floor, and an empty window (0/0) must suppress rather than score perfect timeliness.
 */
export function createDrizzleOrderSeamStore(db: DbClient): OrderSeamStore {
  const fallback = createInMemoryOrderSeamStore().store;
  return {
    ...fallback,
    verbalTimelinessCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: ORDER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where ${V.signedAt} is not null and ${V.signedAt} <= ${V.deadlineAt})::int`,
            })
            .from(V)
            .where(
              and(
                eq(V.organizationId, organizationId),
                gte(V.receivedAt, new Date(window.from)),
                lt(V.receivedAt, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },
  };
}
