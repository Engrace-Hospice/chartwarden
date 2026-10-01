// apps/backend/src/modules/11-orders/outbox-consumers/m21-supply-cancelled.ts — M11's live binding for
// `m21.supply_request.cancelled` (F-166, #248).
//
// F-137 (#248) checked this pair and left it blocked, reasoning that M11's own cascade
// (`consumers/bindings.ts`, F-102) already discontinues its order SYNCHRONOUSLY before it ever emits
// `m11.order.supply_cancellation_requested` — so what M21's catalog gloss ("M11 releases the source
// order") would mean for a cancellation reaching M21 through some OTHER path was left an open, unguessed
// question. F-166 answers it: `cancelSupplyRequest` (`21-supplies/routes/write-service-drizzle.ts`) is a
// SECOND, real producer of this exact catalogued event — a staff member cancelling a `supply_request`
// directly at M21 through `POST /supply-requests/:id/cancel`, never through M11's cascade at all. On THAT
// path the M11 order was never touched and genuinely needs releasing; on the cascade-reply path this
// binding is a true no-op (the order is already `discontinued`, and the machine's `cascadeDiscontinue`
// event is legal only from an in-flight status), which is what makes this consumer safe for BOTH of
// `.cancelled`'s producers rather than only the new one.
//
// `m21.supply_request.cancel_no_op` (the sibling event in this catalog cluster) is DELIBERATELY NOT bound
// here — see `outbox-deferred-consumers.ts` for why: its own catalog description and its one emit site
// (`21-supplies/outbox-consumers/m11-order-cascade.ts`) both confirm it fires ONLY as a reply to M11's own
// `m11.order.supply_cancellation_requested` cascade, at the moment M21 finds the target row already
// terminal — which is exactly the "M11 already discontinued this order itself" case, every time, by
// construction. There is no second producer the way `.cancelled` has one, so there is nothing for a
// consumer to do that M11 does not already know.
//
// WHY `cascadeDiscontinue`, NOT the human `discontinue` event (mirrors `consumers/bindings.ts`'s reasoning
// exactly, one file over): this is a system cascade — nobody at M11 asked for this order to stop, M21's
// own write path did — so `actor_membership_id` must be NULL (§4.5 / W-DC-02's system-actor convention),
// and `cascadeDiscontinue` is legal from `pending_signature`/`verbal_pending` as well as `active`, which
// the human `discontinue` event is not. `cascadeDiscontinue`'s own effects never emit
// `m11.order.supply_cancellation_requested` (unlike `discontinue`'s `fulfillmentInFlight` branch) — which
// is what keeps this from ping-ponging a fresh cascade back at M21 for a cancellation M21 just told M11
// about.
//
// A NEW `order_discontinuation_reason` enum value (`supply_request_cancelled`, migration 0258) was needed:
// every existing member names either a clinical decision a human made or a system cascade M11 itself
// originates (`admission_discharged`, `level_of_care_change`, `standing_order_discontinued`), and none of
// them honestly describes "the downstream fulfillment was cancelled out from under this order by someone
// at M21."
import { type DbClient, schema } from "@wardenx/db";
import { transitionOrder } from "@wardenx/orders";
import { withOrgContext } from "@wardenx/tenancy";
import type { OrderStatus } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";

const OR = schema.orderRecords;
const OD = schema.orderDiscontinuations;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

/** The statuses `cascadeDiscontinue` accepts (the §2.2 graph) — read-side narrowing only; the machine is
 *  still run and is the real authority, so a future graph change cannot silently drift from this filter. */
const IN_FLIGHT: readonly OrderStatus[] = ["pending_signature", "verbal_pending", "active"];

export const M11_SUPPLY_CANCELLED_CONSUMER = {
  eventName: "m21.supply_request.cancelled",
  consumerName: "m11.m21-supply-cancelled",
} as const;

export interface SupplyCancelledDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m11.*` against the boot catalog. */
  readonly outbox: OrderWriteOutboxPort;
  readonly now?: () => Date;
}

interface CancelledPayload {
  readonly sourceOrderId: string | null;
}

function factsOf(payload: unknown): CancelledPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const sourceOrderId = p.sourceOrderId;
  return {
    sourceOrderId:
      typeof sourceOrderId === "string" && sourceOrderId.length > 0 ? sourceOrderId : null,
  };
}

export function buildM11SupplyCancelledConsumer(deps: SupplyCancelledDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M11_SUPPLY_CANCELLED_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [M11_SUPPLY_CANCELLED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.sourceOrderId === null) return; // a supply_request M21 opened itself — no M11 order at all

      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [order] = await tx
            .select({ id: OR.id, status: OR.status })
            .from(OR)
            .where(
              and(eq(OR.organizationId, organizationId), eq(OR.id, facts.sourceOrderId as string)),
            )
            .limit(1);

          // No matching order, or one already terminal — the ordinary case for a cancellation that
          // reached M21 through M11's OWN cascade (F-102), which discontinues the order before it ever
          // asks M21. Also covers a redelivery of this same event after this consumer already ran.
          if (!order || !IN_FLIGHT.includes(order.status as OrderStatus)) return;

          // Raises ILLEGAL_ORDER_TRANSITION / NOT_SYSTEM_ACTOR before anything is written — unreachable
          // given the IN_FLIGHT filter above, run anyway so a future graph edge cannot silently drift.
          transitionOrder(order.status as OrderStatus, {
            type: "cascadeDiscontinue",
            isSystemActor: true,
            reason: "supply_request_cancelled",
          });

          const at = now();
          const updated = await tx
            .update(OR)
            .set({ status: "discontinued", discontinuedAt: at, updatedAt: at })
            .where(
              and(
                eq(OR.organizationId, organizationId),
                eq(OR.id, order.id),
                eq(OR.status, order.status),
              ),
            )
            .returning({ id: OR.id });
          if (updated.length === 0) return; // lost a race to a concurrent redelivery/manual transition

          const [discontinuation] = await tx
            .insert(OD)
            .values({
              organizationId,
              orderRecordId: order.id,
              targetKind: "order",
              actorMembershipId: null,
              reason: "supply_request_cancelled",
              effectiveAt: at,
              sourceOutboxEventId: event.id,
            })
            .returning({ id: OD.id });
          const discontinuationId = discontinuation?.id;
          if (!discontinuationId) throw new Error("order_discontinuation insert returned no row");

          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m11.order.discontinued",
            aggregateKind: "order",
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              discontinuationId,
              reason: "supply_request_cancelled",
              actorMembershipId: null,
              effectiveAt: at.toISOString(),
            },
          });
        },
      );
    },
  };
}
