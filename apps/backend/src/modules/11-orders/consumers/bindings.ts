// apps/backend/src/modules/11-orders/consumers/bindings.ts — the live `OutboxConsumerBinding` for M11's
// §2.6 D13 discharge cascade (F-102 / #103).
//
// WHAT WAS MISSING. `decideDischargeCascade` beside this file was complete, exported and unit-tested since
// M11-T07, and its only caller was `orders-outbox-consumers.test.ts`. There was no factory yielding a
// binding — and there could not have been one, because M11 was not in `m6.admission.discharged`'s
// `declaredConsumers` at all, and `assertBindableAgainstCatalog` refuses a binding whose module the catalog
// does not name. So the absence was two-sided and each side made the other invisible: nothing to bind, and
// nowhere to bind it. Every order still in flight when a patient was discharged — a pending-signature lab,
// a verbal-pending comfort kit, an active DME rental — stayed in flight forever, on an admission that had
// ended in death, revocation, transfer or live discharge.
//
// ── WHY NOT `discontinueOrder` ────────────────────────────────────────────────────────────────────────
//
// The decider's own header used to say the worker executes "through M11's `discontinueOrder` service path".
// It cannot, and this is the substantive part of the fix rather than a routing preference:
//
//   • `discontinueOrder` writes `actorMembershipId: userId` — the CALLER. §4.5 / W-DC-02 requires
//     `actor_membership_id = NULL` for the cascade, and the column has been nullable since M11's schema
//     landed with the comment "NULL for system-actor cascades; the audit row captures the source event".
//     Routing a system cascade through the human path would attribute a discontinuation to a clinician who
//     did nothing — on a chart a surveyor reads.
//   • `discontinueOrder` never writes `source_outbox_event_id`. That column exists for exactly this
//     provenance and NOTHING in the repository has ever written it.
//   • It runs the machine's `discontinue` event, not `cascadeDiscontinue`. `cascadeDiscontinue` is legal
//     from `pending_signature` and `verbal_pending` as well as `active` (the §2.2 graph), which is the
//     whole point of a cascade — the human event is `active`-only from `active`, so two thirds of the
//     in-flight orders would have raised ILLEGAL_ORDER_TRANSITION.
//
// So this executor runs `transitionMedicationOrder`'s M11 sibling `transitionOrder(status,
// {type:"cascadeDiscontinue", isSystemActor:true, reason})` and applies its effects itself. The machine's
// guard (`NOT_SYSTEM_ACTOR`) is the reason it is run at all rather than assumed: the decider filtered the
// statuses, and running the machine is what keeps a future effect it adds from being silently dropped.
//
// ── ATTRIBUTION AND SCOPE ─────────────────────────────────────────────────────────────────────────────
//
// `userId` is empty — the dispatcher's own convention. §3.3's attribution rule says a system transition
// records no actor, and a discharge cascade is nobody's act. The M4 write-audit triggers record the row
// writes either way, and `source_outbox_event_id` is what ties them back to the discharge.
//
// The read and both writes are M11-owned tables inside one `withOrgContext`, so RLS scopes them as
// `chartwarden_app`. The consumed event name is a STRING literal and no M6 schema is imported: M11 reads M6
// solely through the foundation outbox, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@chartwarden/db";
import { transitionOrder } from "@chartwarden/orders";
import { withOrgContext } from "@chartwarden/tenancy";
import type { OrderKind, OrderStatus } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";
import {
  type DischargeDiscontinueAction,
  type OrderOnAdmission,
  decideDischargeCascade,
} from "./admission-discharged-discontinue";

const OR = schema.orderRecords;
const OD = schema.orderDiscontinuations;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M11's discharge cascade consumes, and the `(eventId, consumerName)` receipt identity. */
export const M11_DISCHARGE_CASCADE_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m11.admission-discharged-discontinue",
} as const;

/** The statuses the cascade acts on. Read-side narrowing only — {@link decideDischargeCascade} is still the
 *  authority, and a row that slips past this filter is counted as skipped there. Kept in step with the
 *  decider's own set by the agreement case in `orders-outbox-consumers.test.ts`. */
const IN_FLIGHT: readonly OrderStatus[] = ["pending_signature", "verbal_pending", "active"];

export interface OrdersConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — it `Value.Check`s each payload against the boot catalog and rolls the tx back
   *  on a mismatch. A cascade that emits an invalid `m11.order.discontinued` must not leave the order
   *  flipped, which is exactly what the shared transaction gives. */
  readonly outbox: OrderWriteOutboxPort;
  readonly now?: () => Date;
}

/** The `m6.admission.discharged` payload M11 reads off the wire (M6 owns the canonical shape). */
function admissionIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { readonly admissionId?: unknown }).admissionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Apply ONE discontinuation: the machine's `cascadeDiscontinue` effects, written on the caller's tx.
 *
 * The `status` predicate on the UPDATE is the concurrency guard, not decoration. The read and the write
 * are separate statements, so a clinician signing the same order between them would otherwise be silently
 * overwritten; with it, a zero-row update means the order moved and the cascade skips it rather than
 * emitting a discontinuation for a row it did not change.
 */
async function applyDiscontinuation(
  tx: DbClient,
  organizationId: string,
  order: OrderOnAdmission,
  action: DischargeDiscontinueAction,
  outbox: OrderWriteOutboxPort,
  now: Date,
): Promise<boolean> {
  // Raises NOT_SYSTEM_ACTOR / ILLEGAL_ORDER_TRANSITION before anything is written.
  transitionOrder(order.status, {
    type: "cascadeDiscontinue",
    isSystemActor: true,
    reason: action.reason,
  });

  const updated = await tx
    .update(OR)
    .set({ status: "discontinued", discontinuedAt: now, updatedAt: now })
    .where(
      and(
        eq(OR.organizationId, organizationId),
        eq(OR.id, action.orderId),
        eq(OR.status, order.status),
      ),
    )
    .returning({ id: OR.id });
  if (updated.length === 0) return false;

  const rows = await tx
    .insert(OD)
    .values({
      organizationId,
      orderRecordId: action.orderId,
      targetKind: "order",
      // §4.5 / W-DC-02 — the cascade is a system actor. The column is nullable for this case alone.
      actorMembershipId: action.actorMembershipId,
      reason: action.reason,
      effectiveAt: now,
      sourceOutboxEventId: action.sourceOutboxEventId,
    })
    .returning({ id: OD.id });
  const discontinuationId = rows[0]?.id;
  if (!discontinuationId) throw new Error("order_discontinuation insert returned no row");

  await outbox.publish(tx, {
    eventName: "m11.order.discontinued",
    organizationId,
    aggregateKind: "order",
    aggregateId: action.orderId,
    payload: {
      orderId: action.orderId,
      discontinuationId,
      reason: action.reason,
      actorMembershipId: action.actorMembershipId,
      effectiveAt: now.toISOString(),
    },
  });

  if (action.emitSupplyCancellation) {
    await outbox.publish(tx, {
      eventName: "m11.order.supply_cancellation_requested",
      organizationId,
      aggregateKind: "order",
      aggregateId: action.orderId,
      payload: {
        orderId: action.orderId,
        // NULL, always, and not a gap: M11 holds no supply-request reference, and M21's own payload doc
        // says it "keys on `orderId` regardless, because M11's ref can be stale".
        originalSupplyRequestRef: null,
      },
    });
  }
  return true;
}

/**
 * M11's live `m6.admission.discharged` binding (§2.6 D13 / §4.5 / W-DC-02).
 *
 * Idempotent by construction at two levels: the dispatcher's `(eventId, consumerName)` receipt means a
 * redelivery does not re-run at all, and if one does (a crash between effect and receipt) every order is
 * already `discontinued`, which the decider counts as skipped.
 */
export function buildM11DischargeCascadeConsumer(deps: OrdersConsumerDeps): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M11_DISCHARGE_CASCADE_CONSUMER.consumerName,
    consumerModule: "m11",
    eventTypes: [M11_DISCHARGE_CASCADE_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const admissionId = admissionIdOf(event.payload);
      if (admissionId === null) {
        throw new Error(
          `${M11_DISCHARGE_CASCADE_CONSUMER.consumerName}: payload has no admissionId`,
        );
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select({ id: OR.id, status: OR.status, kind: OR.kind })
            .from(OR)
            .where(
              and(
                eq(OR.organizationId, organizationId),
                eq(OR.admissionId, admissionId),
                inArray(OR.status, IN_FLIGHT),
              ),
            );
          const ordersOnAdmission: OrderOnAdmission[] = rows.map((r) => ({
            orderId: r.id,
            status: r.status as OrderStatus,
            kind: r.kind as OrderKind,
          }));

          const action = decideDischargeCascade(
            { admissionId, organizationId, dischargeEventId: event.id },
            { ordersOnAdmission },
          );
          const byId = new Map(ordersOnAdmission.map((o) => [o.orderId, o]));
          const at = now();
          for (const d of action.discontinuations) {
            const order = byId.get(d.orderId);
            if (!order) continue;
            await applyDiscontinuation(tx, organizationId, order, d, deps.outbox, at);
          }
        },
      );
    },
  };
}
