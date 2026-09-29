// apps/backend/src/modules/11-orders/outbox-consumers/lab-cancellation-required.ts — F-185 (#248): when a lab order
// is SUPERSEDED (discontinued, or replaced by a corrected order) after its ORM may already be at the laboratory,
// tell a human, because nothing else will.
//
// THE GAP. `m11.order.discontinued` (the route, the discharge cascade) and `m11.order.corrected` (the supersede
// trigger, §164.526) end an order's LIFECYCLE. Neither reaches the laboratory: the ORM^O01 M29 sent is not
// withdrawn, the lab runs the test, and the corrected order legitimately goes out as a SECOND ORM under a new
// placer order number.
//
// WHY THIS IS AN ALERT AND NOT AN HL7 CANCEL (the F-185 spec decision — do not "finish" it without a spec change):
//   * T-29.08 (`WARDENX_T-29.08_OUTBOUND_ORM.md`) defines ONE outbound message: `ORM^O01` with `ORC-1 = NW`
//     (`orm-o01.ts` hardcodes it). No `CA` / `OC` / `DC` order-control flow, no cancel message type, no cancel
//     idempotency rule and no partner-lab acknowledgement semantics are defined anywhere in the M29 spec, the
//     task specs or `WARDENX_INTEGRATIONS_v0_1.md`. The "cancel" in the M29 spec is inbound `ADT^A11`
//     (cancel admission) and the `cancelled` LAB RESULT status — neither is an outbound order cancel.
//   * M11's spec lists M21 (supplies) as the consumer of a decisive `m11.order.supply_cancellation_requested`
//     (§4.5) and names NO equivalent for lab. `m11.order.discontinued`'s consumers exclude M29.
//   * A cancel is not "the reverse of a send": whether a lab honours `ORC-1=CA` after collection, whether the ACK
//     of a cancel proves anything (it does not — results may still arrive), and whether a lab wants `CA` or a
//     `DC`/`OC` per contract are PARTNER-LAB decisions. Inventing one would put an unspecified message on a
//     production PHI channel.
// So this consumer does the part the specs DO support: it makes the discrepancy operator-visible (an M36 alert to
// the patient's care team, through the same `AlertEmitter` seam M29's own operator alerts use) with the ids they
// need to phone the lab and, for a correction, both halves of the pair. A protocol-level cancel needs a spec
// decision (ORC-1 code per partner, ack semantics, the cancel's own idempotency key vs F-183's order-level dedupe).
//
// WHEN AN ALERT IS RAISED (`decideLabCancellation`, pure): only when the order may still be at the lab.
//   transmitted            → `transmitted`           the lab has it (AA/AE/AR received)
//   pending / pending_retry→ `in_flight`             the ORM was requested and has not been acknowledged yet, so it
//                                                    may still be sent AFTER this discontinuation
//   failed (M29 terminal)  → `delivery_unverified`   a send may have reached the lab before the failure (F-183 holds
//                                                    these for exactly that reason)
//   failed `orm_refused:*` → nothing                 the ORM was never produced, so nothing left the building
//   not_required           → nothing                 not a lab order
//   never signed           → nothing                 `insertDraft` writes `transmission_status='pending'` on EVERY lab
//                                                    draft, so `pending` alone does not mean an ORM was requested; the
//                                                    emitter only runs at SIGN, so `signed_at` is the real signal
//   results already in     → nothing                 the lab has finished; there is nothing to cancel
//
// EXACTLY ONCE. An order leaves an in-flight status once, so it yields ONE `m11.order.discontinued` OR ONE
// `m11.order.corrected` (the trigger discontinues silently; `correctOrder` publishes only `corrected`). The relay
// dedupes on `(eventId, consumerName)` and the alert carries a per-order correlation id.
//
// NO PHI: ids, enum tokens and reasons only — never a name, DOB, MRN or result value.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const OR = schema.orderRecords;

/** §3.3 — a consumer-driven read names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M11_LAB_CANCELLATION_CONSUMER = {
  eventNames: ["m11.order.discontinued", "m11.order.corrected"] as const,
  consumerName: "m11.lab-cancellation-required",
} as const;

/** The M36 alert `eventType` (the platform-default `alert_rule` key in `@wardenx/messaging`'s seed). */
export const M11_LAB_CANCELLATION_ALERT_TYPE = "m11.order.lab_cancellation_required";

export type LabCancellationState = "transmitted" | "in_flight" | "delivery_unverified";

export interface LabCancellationFacts {
  readonly kind: string;
  /** `order_record.signed_at` — set only when the order is signed, which is when F-181's emitter runs. */
  readonly signedAt: Date | null;
  readonly transmissionStatus: string;
  readonly transmissionFailureReason: string | null;
  readonly resultsStatus: string;
}

/** Pure: does a superseded lab order need a human to tell the lab, and in which state is it? `null` ⇒ nothing. */
export function decideLabCancellation(facts: LabCancellationFacts): LabCancellationState | null {
  if (facts.kind !== "lab") return null;
  // Never signed ⇒ no ORM was ever requested, whatever `transmission_status` says (drafts are born `pending`).
  if (facts.signedAt === null) return null;
  // The lab has finished (or partly finished) — results are back, so there is no pending work to withdraw.
  if (facts.resultsStatus === "results_received") return null;
  switch (facts.transmissionStatus) {
    case "transmitted":
      return "transmitted";
    case "pending":
    case "pending_retry":
      return "in_flight";
    case "failed":
      // F-181 refusals never produced an ORM; every other failure is an M29 terminal one (delivery unverified).
      return facts.transmissionFailureReason?.startsWith("orm_refused:") ? null : "delivery_unverified";
    default:
      return null; // `not_required`: never signed / not a transmitted order
  }
}

/** The M36 `AlertEmitter` seam's structural shape — declared locally (M11 never imports a concrete M36 package),
 *  the same inline-cast precedent `dispatch-worker.ts`'s `OutboundAlertPort` uses. */
export interface LabCancellationAlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

export interface LabCancellationDeps {
  readonly db: DbClient;
  readonly alerts: LabCancellationAlertPort;
}

interface SupersessionFacts {
  readonly orderId: string;
  readonly replacedByOrderId: string | null;
  readonly supersededBy: "discontinued" | "corrected";
  readonly discontinuationReason: string | null;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function factsOf(eventType: string, payload: unknown): SupersessionFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const name = M11_LAB_CANCELLATION_CONSUMER.consumerName;
  if (eventType === "m11.order.discontinued") {
    const orderId = str(p, "orderId");
    if (!orderId) throw new Error(`${name}: discontinued payload has no orderId`);
    return { orderId, replacedByOrderId: null, supersededBy: "discontinued", discontinuationReason: str(p, "reason") };
  }
  if (eventType === "m11.order.corrected") {
    // The ORIGINAL is the order at the lab; the new order is its replacement.
    const orderId = str(p, "replacedOrderId");
    if (!orderId) throw new Error(`${name}: corrected payload has no replacedOrderId`);
    return { orderId, replacedByOrderId: str(p, "newOrderId"), supersededBy: "corrected", discontinuationReason: null };
  }
  throw new Error(`${name}: unexpected event '${eventType}'`);
}

export function buildM11LabCancellationConsumer(deps: LabCancellationDeps) {
  return {
    consumerName: M11_LAB_CANCELLATION_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [...M11_LAB_CANCELLATION_CONSUMER.eventNames],
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.eventType, event.payload);
      const organizationId = event.organizationId;

      const order = await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const [row] = await tx
          .select({
            patientId: OR.patientId,
            status: OR.status,
            kind: OR.kind,
            transmissionStatus: OR.transmissionStatus,
            transmissionFailureReason: OR.transmissionFailureReason,
            resultsStatus: OR.resultsStatus,
            signedAt: OR.signedAt,
          })
          .from(OR)
          .where(and(eq(OR.organizationId, organizationId), eq(OR.id, facts.orderId)))
          .limit(1);
        return row ?? null;
      });
      // A stale redelivery / another tenant's id (RLS hides it) is a benign no-op, not a dead-letter.
      if (!order || order.status !== "discontinued") return;

      const labState = decideLabCancellation(order);
      if (labState === null) return;

      // Ids and tokens only. `patientId` is the care-team resolver's path (`patientIdPath`), not PHI content.
      await deps.alerts.emit(organizationId, {
        eventType: M11_LAB_CANCELLATION_ALERT_TYPE,
        payload: {
          orderId: facts.orderId,
          patientId: order.patientId,
          replacedByOrderId: facts.replacedByOrderId,
          supersededBy: facts.supersededBy,
          discontinuationReason: facts.discontinuationReason,
          labState,
          transmissionStatus: order.transmissionStatus,
          deepLink: `/orders/${facts.orderId}`,
        },
        severity: "warn",
        correlationId: `m11-lab-cancel:${facts.orderId}`,
      });
      console.info("m11.lab_cancellation.required", {
        orderId: facts.orderId,
        supersededBy: facts.supersededBy,
        labState,
      });
    },
  };
}
