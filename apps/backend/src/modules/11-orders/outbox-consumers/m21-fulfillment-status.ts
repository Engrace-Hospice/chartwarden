// apps/backend/src/modules/11-orders/outbox-consumers/m21-fulfillment-status.ts — the D8 one-shot
// auto-complete consumer (F-15x, #248).
//
// M11's own locked spec is decisive and precise about this one relationship, and about nothing else in
// the m21 cluster: D8 states "M21 emits `m21.supply_request.status_changed` consumed by M11's
// `m21-fulfillment-status` consumer for one-shot kind auto-completion", and §4.5's trigger table spells
// out the exact rule — "If `status='delivered'` and the M11 order's kind is one-shot, auto-complete the
// order." The file was named in M11's own file tree (`m21-fulfillment-status.ts`) and never built; a
// checklist item filed it as a "(forward seam) fixture until M21 locks" — M21 has been locked and
// emitting this event for a long time, and nothing was ever bound.
//
// ONE-SHOT KIND, PRECISELY: `supply` and `comfort_kit` only, never `dme`. The spec's own §2.2 status-
// transition prose draws that line explicitly — "a `dme` order completes when M21 records receipt", a
// DIFFERENT M21 signal from "delivered", and the existing (already-live) M21→M11 discharge-cascade
// consumer already closes DME out via its own monthly-rental close-out path (a direct `discontinueOrder`
// call, not this one). Folding `dme` into "delivered ⇒ complete" here would auto-complete a rental that
// is still billing monthly.
//
// NOT REUSING `completeOrder` (`orders-route-service-db.ts`): that method hardcodes
// `kindAutoOrManual: "manual"` for its one caller, the staff `POST /orders/:id/complete` route. Rather
// than widen a shared, already-tested route method's signature for a second caller, this consumer writes
// the completion directly — the exact same three effects the machine's own `complete` case declares
// (`set_timestamp completed_at`, `audit`, `outbox m11.order.completed`) — with `kindAutoOrManual: "auto"`,
// the literal the catalog schema's own enum already reserves for exactly this path (its description reads
// "manual clinician review OR system one-shot auto-complete").
//
// IDEMPOTENT BY DESIGN, NOT BY THROWING: `transitionOrder`'s `active` state is the only one that accepts
// `complete` (`order-machine.ts`'s `BEREAVED`-shaped graph — `active: ["complete","discontinue",
// "cascadeDiscontinue"]`). A redelivery of the same `delivered` status change after the order already
// completed finds a non-`active` row and is a benign, audited skip — never a machine throw, because a
// redelivered fact is expected at-least-once outbox behavior, not a data problem worth dead-lettering.
//
// `cancelled` / `cancel_no_op` (the other two events in this catalog cluster) are DELIBERATELY NOT bound
// here — see the outbox-deferred-consumers.ts reason text for why: M11's own spec names neither, and
// tracing the discharge cascade (`consumers/bindings.ts`) shows the M11 order is already synchronously
// discontinued in the SAME transaction that emits `m11.order.supply_cancellation_requested`, before M21
// ever replies — so what "M11 releases the source order" (M21's own catalog gloss on `.cancelled`) would
// mean for a request cancelled through some OTHER path (never through M11's cascade) is a genuine, open
// question this pass does not guess at.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { OrderKind } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";

const ORDER = schema.orderRecords;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

/** D8 / §2.2 — the M11 order kinds that complete automatically on M21 delivery. `dme` is excluded: it
 *  completes on receipt via a separate monthly-rental close-out, not on "delivered". */
const ONE_SHOT_KINDS: ReadonlySet<OrderKind> = new Set<OrderKind>(["supply", "comfort_kit"]);

export const M11_FULFILLMENT_STATUS_CONSUMER = {
  eventName: "m21.supply_request.status_changed",
  consumerName: "m11.m21-fulfillment-status",
} as const;

export interface FulfillmentStatusDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m11.*` against the boot catalog. */
  readonly outbox: OrderWriteOutboxPort;
}

interface StatusChangedPayload {
  readonly sourceOrderId: string | null;
  readonly toStatus: string;
}

function factsOf(payload: unknown): StatusChangedPayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toStatus = p.toStatus;
  if (typeof toStatus !== "string" || toStatus.length === 0) {
    throw new Error(`${M11_FULFILLMENT_STATUS_CONSUMER.consumerName}: payload has no toStatus`);
  }
  const sourceOrderId = p.sourceOrderId;
  return {
    toStatus,
    sourceOrderId: typeof sourceOrderId === "string" && sourceOrderId.length > 0 ? sourceOrderId : null,
  };
}

export function buildM11FulfillmentStatusConsumer(deps: FulfillmentStatusDeps) {
  return {
    consumerName: M11_FULFILLMENT_STATUS_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [M11_FULFILLMENT_STATUS_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      if (facts.toStatus !== "delivered" || facts.sourceOrderId === null) return;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [order] = await tx
            .select({ id: ORDER.id, status: ORDER.status, kind: ORDER.kind })
            .from(ORDER)
            .where(and(eq(ORDER.organizationId, organizationId), eq(ORDER.id, facts.sourceOrderId as string)))
            .limit(1);

          // No matching order, an order not in `active`, or a non-one-shot kind (dme) — all benign no-ops.
          // A non-active row covers both "already completed" (idempotent redelivery) and "not yet active"
          // (a draft/pending-signature order that was somehow already marked delivered — refuses to guess
          // a completion the machine's own graph would refuse too).
          if (!order || order.status !== "active" || !ONE_SHOT_KINDS.has(order.kind)) return;

          const at = new Date();
          const updated = await tx
            .update(ORDER)
            .set({ status: "completed", completedAt: at, updatedAt: at })
            .where(
              and(
                eq(ORDER.organizationId, organizationId),
                eq(ORDER.id, order.id),
                eq(ORDER.status, "active"),
              ),
            )
            .returning({ id: ORDER.id });
          if (updated.length === 0) return; // lost a race to a concurrent redelivery/manual complete

          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m11.order.completed",
            aggregateKind: "order",
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              completedAt: at.toISOString(),
              kindAutoOrManual: "auto",
            },
          });
        },
      );
    },
  };
}
