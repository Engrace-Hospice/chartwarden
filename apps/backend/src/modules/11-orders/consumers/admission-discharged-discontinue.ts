// apps/backend/src/modules/11-orders/consumers/admission-discharged-discontinue.ts — the discharge-
// cascade auto-discontinue consumer (M11-T07, spec §2.6 D13 / §4.5 / W-DC-02). PHASE-1 PURE DECISION CORE.
//
// F-102 — THIS IS NO LONGER PHASE-1-PURE. The decision core below had no caller but its own test for the
// whole of its life, and M11 was not in `m6.admission.discharged`'s `declaredConsumers`, so nothing could
// have bound it: every order in flight on a discharged admission stayed in flight forever. `./bindings.ts`
// is the live `OutboxConsumerBinding` that runs it.
//
// M6 (Admission) emits `m6.admission.discharged` when a patient is discharged (death / revocation /
// transfer / live discharge). M11 subscribes: every order still in flight on that admission is
// system-discontinued with `reason='admission_discharged'` and `actor_membership_id=null`, the discharge
// event id stamped into `source_outbox_event_id`. Each discontinued order emits `m11.order.discontinued`;
// any supply-kind order ALSO emits `m11.order.supply_cancellation_requested` (§2.6 / W-DC-02 — see
// {@link OrderOnAdmission} for why the in-flight test moved to M21). Death does not retroactively
// un-discontinue a comfort kit already deployed in the verbal_pending window — the order is discontinued
// and the verbal non-signature is preserved for survey.
//
// This file is the PURE decision core {@link decideDischargeCascade}: given the parsed payload + the facts
// the worker reads (the orders on the admission with their lifecycle status and kind), it returns the
// {@link DischargeCascadeAction} list `./bindings.ts` executes. That executor runs the machine's own
// `cascadeDiscontinue` event rather than the human `discontinueOrder` route path, which this header used
// to name: that path writes the CALLER as `actor_membership_id` and never writes `source_outbox_event_id`,
// so a system cascade going through it would have been attributed to a clinician who did nothing. The
// consumed event name is a STRING literal only (no M6 schema import): M11 reads M6 solely through the
// foundation outbox, never via a `dependsOn` edge (§4 boundary rule).
import type { OrderKind, OrderStatus } from "@wardenx/types";

// ── The discharged payload M11 consumes (M6 owns the canonical wire shape) ────────────────────────────

/** The `m6.admission.discharged` payload subset M11 reads to run the cascade. M6 owns the canonical type
 * + the `mN.` wire name; this leaf-typed projection is the single point to reconcile if M6 namespaces it
 * differently. M11 does NOT read M6's schema — only this projection. */
export interface AdmissionDischargedPayload {
  readonly admissionId: string;
  readonly organizationId: string;
  /** The outbox event id of the discharge — stamped into each discontinuation's `source_outbox_event_id`. */
  readonly dischargeEventId: string;
}

// ── The facts the worker reads before deciding (resolved by the live consumer from M11 reads) ─────────

/** One order on the discharged admission, as the worker reads it (status + kind).
 *
 * F-102 — this carried a third field, `supplyFulfillmentInFlight`, and `emitSupplyCancellation` was gated
 * on it. M11 CANNOT PRODUCE THAT FACT: `order_record` holds no supply-request reference (M21's
 * `supply_request` points at the order, not the other way round), and `SupplyFulfillmentProvider.isTerminal`
 * — the seam whose doc says "M11 asks this before issuing a cancellation" — takes a `SupplyRequestId` M11
 * never sees. So the only value the live consumer could honestly pass was `false`, and `false` meant M21
 * was never told: the cascade would discontinue a DME rental and leave the vendor order standing.
 *
 * The gate is gone rather than the fact invented, because M21 already answers this question and says so.
 * `M11SupplyCancellationRequestedPayload` documents `originalSupplyRequestRef` as "M11's own record … M21
 * keys on `orderId` regardless, because M11's ref can be stale", and `decideSupplyCancellationCascade`
 * returns `no_match` — emitting nothing — when no request exists for the order. Asking about an order that
 * was never fulfilled is a no-op M21 is built for; not asking about one that was is a live vendor order on
 * a discharged patient. */
export interface OrderOnAdmission {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly kind: OrderKind;
}

/** Everything the worker must read before it can decide, surfaced as data so the decider stays pure. The
 * live consumer resolves the order list from M11's own `order_record` table scoped to the admission. */
export interface DischargeCascadeFacts {
  readonly ordersOnAdmission: readonly OrderOnAdmission[];
}

// ── The effect descriptors the decider returns (executed by the live consumer) ─────────────────────────

/** The §2.6 supply kinds whose in-flight fulfillment must be cancelled when the order is discontinued. */
const SUPPLY_KINDS: ReadonlySet<OrderKind> = new Set<OrderKind>(["dme", "supply", "comfort_kit"]);

/** The §2.6 in-flight order statuses the cascade discontinues (terminal states are left untouched). */
const CASCADE_DISCONTINUABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "pending_signature",
  "verbal_pending",
  "active",
]);

/** A single per-order discontinuation the worker executes through `discontinueOrder` (system actor). */
export interface DischargeDiscontinueAction {
  readonly orderId: string;
  /** Always `admission_discharged` for the cascade (§2.6 reason enum). */
  readonly reason: "admission_discharged";
  /** Null — the cascade is a system actor, not a clinician (§4.5 / W-DC-02). */
  readonly actorMembershipId: null;
  /** Stamped into `order_discontinuation.source_outbox_event_id` for provenance. */
  readonly sourceOutboxEventId: string;
  /** True for a DME/supply/comfort_kit order — the live worker also emits
   *  `m11.order.supply_cancellation_requested` and M21 decides whether anything is open (see
   *  {@link OrderOnAdmission}). */
  readonly emitSupplyCancellation: boolean;
}

/** The full cascade plan: the per-order discontinuations + a count of terminal orders left alone. */
export interface DischargeCascadeAction {
  readonly discontinuations: readonly DischargeDiscontinueAction[];
  /** Orders already in a terminal state (`completed` / `discontinued` / `expired_unsigned` / `draft`) — skipped. */
  readonly skippedCount: number;
}

// ── The pure decision core (§2.6 D13 / §4.5 / W-DC-02) ─────────────────────────────────────────────────

/**
 * Decide the discharge cascade for an `m6.admission.discharged` delivery (pure). The worker resolves the
 * order list on the admission, then this returns one {@link DischargeDiscontinueAction} per in-flight order
 * (status ∈ {pending_signature, verbal_pending, active}); terminal orders are counted as skipped and left
 * untouched. A supply-kind order is flagged so the live worker also emits
 * `m11.order.supply_cancellation_requested`. Idempotent by construction: a redelivery sees the already-
 * discontinued orders as terminal and skips them.
 */
export function decideDischargeCascade(
  payload: AdmissionDischargedPayload,
  facts: DischargeCascadeFacts,
): DischargeCascadeAction {
  const discontinuations: DischargeDiscontinueAction[] = [];
  let skippedCount = 0;

  for (const order of facts.ordersOnAdmission) {
    if (!CASCADE_DISCONTINUABLE.has(order.status)) {
      skippedCount += 1;
      continue;
    }
    discontinuations.push({
      orderId: order.orderId,
      reason: "admission_discharged",
      actorMembershipId: null,
      sourceOutboxEventId: payload.dischargeEventId,
      emitSupplyCancellation: SUPPLY_KINDS.has(order.kind),
    });
  }

  return { discontinuations, skippedCount };
}
