// apps/backend/src/modules/21-supplies/lifecycle/supply-request.ts — M21-T03 (§2.2 / D2).
//
// The fulfillment machine: requested → vendor_assigned → ordered → in_transit → delivered →
// received_confirmed → completed, with the two-phase post-`ordered` cancellation and the kit-only
// `returned` branch.
//
// THE GRAPH IS NOT RESTATED HERE. Every legal edge comes from `SUPPLY_REQUEST_EDGES` in `@chartwarden/supplies`
// (the package header promises exactly this), so the graph the machine runs, the graph the §5 UI timeline
// renders and the graph the tests walk are one object. This file owns only what an edge table cannot carry:
// the per-transition GUARDS and the §2.11 side-effect list.
//
// Three readings worth stating at the top:
//
//   1. **`vendorRefusedCancellation` is not an error path.** The vendor's "no, it already shipped" is an
//      ANSWER. The row returns to the state it actually left and a `medium` alert goes to compliance; a
//      DME on the truck is not un-shipped by our writing a status.
//
//   2. **`completeRequest` is three different rules behind one edge.** A one-shot DME/supply completes on
//      receipt; a monthly rental stays open for the rental life so the recurring HCPCS line has a row to
//      accrue against, and completes only on M11's discontinuation; a kit completes only on M13's ack. The
//      predicate lives in `@chartwarden/supplies` (`autoCompletesOnReceipt`) and the two waiting cases are
//      distinct error codes so a stalled-rental screen never reads as a stalled kit.
//
//   3. **`system_auto_confirm` is gated on the clock, not on intent.** The 72h fallback is the one actor
//      value meaning "nobody actually said yes"; firing it early would manufacture a receipt confirmation
//      that never happened, so the guard checks the elapsed grace rather than trusting the caller.
import {
  type SupplyRequestTransition,
  allowedTransitions,
  autoCompletesOnReceipt,
  isReceivedConfirmAutoDue,
  isTerminalSupplyStatus,
  isVendorAssignmentCoherent,
  isVendorConfirmationOverdue,
  resolveTransition,
} from "@chartwarden/supplies";
import type {
  DmeRentalCadence,
  IsoInstant,
  RoutingRuleResolved,
  SupplyCourierAttestation,
  SupplyReceivedConfirmedActor,
  SupplyRequestKind,
  SupplyRequestStatus,
} from "@chartwarden/types";
import { type SupplySideEffect, type SupplyTransitionResult, result, withAudit } from "./effects";
import { SupplyStateError, require_ } from "./errors";

/** The §2.2 states (mirrors `m21_supply_request_status`). */
export type SupplyRequestLifecycleState = SupplyRequestStatus;

/** The §2.2 events. One per labelled edge, carrying the facts the guard needs already resolved — the
 *  machine never reads a seam, a clock or a row. */
export type SupplyRequestEvent =
  | {
      /** D4 — the routing ladder produced a resolution; freeze it. */
      readonly type: "assignVendor";
      readonly resolved: RoutingRuleResolved;
      /** The M40 `MdmEntityProvider.assertVendorActive` answer. `null` when the resolution names no vendor
       *  (internal hub / pharmacy paths), where a vendor check is not merely unnecessary but meaningless. */
      readonly vendorActive: boolean | null;
      readonly at: IsoInstant;
    }
  | {
      /** §2.2 — Phase-1 portal/email/fax entry, Phase-2 the EDI 855 ack. Kit kinds also create the
       *  dispatch row on this edge, in the SAME transaction (§2.5). */
      readonly type: "placeOrderWithVendor";
      readonly vendorOrderReference: string;
      readonly at: IsoInstant;
      /** Kit kinds only — the validated dispatch line count (see ./dispatch). Zero is a refusal, not an
       *  empty kit: a kit with nothing in it is a chain-of-custody record of nothing. */
      readonly dispatchLineCount?: number;
    }
  | {
      readonly type: "vendorConfirmedShipment";
      readonly trackingNumber: string;
      readonly carrier: string;
      readonly at: IsoInstant;
    }
  | {
      /** D7 — the courier attestation. Required on EVERY kind (see the guard). */
      readonly type: "confirmDeliveryAtAddress";
      readonly attestation: SupplyCourierAttestation;
    }
  | {
      readonly type: "caregiverOrPatientConfirmsReceipt";
      readonly actor: SupplyReceivedConfirmedActor;
      readonly at: IsoInstant;
      /** When the row reached `delivered` — only read on the `system_auto_confirm` path. */
      readonly deliveredAt?: IsoInstant;
    }
  | {
      readonly type: "completeRequest";
      readonly at: IsoInstant;
      /** DME only; `null` for the other kinds. */
      readonly rentalCadence: DmeRentalCadence | null;
      /** `m11.order.discontinued` arrived for the source order (the rental-pickup path). */
      readonly orderDiscontinued?: boolean;
      /** M13 acked the deployment / replenishment (`m13.comfort_kit.deployed`). */
      readonly m13Acked?: boolean;
    }
  | {
      /** §2.2 — the immediate pre-`ordered` cancellation. Nothing was promised to anyone yet. */
      readonly type: "cancel";
      readonly reason: string;
      readonly at: IsoInstant;
    }
  | {
      /** §2.2 — post-`ordered`: the cancellation is a REQUEST until the vendor answers. */
      readonly type: "requestCancellation";
      readonly reason: string;
      readonly at: IsoInstant;
    }
  | {
      readonly type: "vendorConfirmedCancellation";
      readonly reason: string;
      readonly at: IsoInstant;
    }
  | {
      /** §2.2 — the refusal walks the row BACK to where it was. */
      readonly type: "vendorRefusedCancellation";
      readonly restoreTo: Extract<SupplyRequestStatus, "ordered" | "in_transit">;
      readonly vendorReason: string | null;
    }
  | {
      /** §2.6 — the M13 return-required cascade. Kit kinds only (enforced by the edge table). */
      readonly type: "initiateReturn";
      readonly at: IsoInstant;
    }
  | {
      readonly type: "completeReturnReconciliation";
      readonly at: IsoInstant;
      /** The `comfort_kit_return` row reached `reconciled` (see ./return). */
      readonly returnReconciled: boolean;
    };

export type SupplyRequestTransitionResult = SupplyTransitionResult<
  SupplyRequestLifecycleState,
  SupplyRequestEvent["type"]
>;

/** Every §2.2 transition emits `status_changed` — M11 auto-completes one-shot orders off it, M33 counts it
 *  and M4 audits it. Declared once so no edge can forget. */
const STATUS_CHANGED: SupplySideEffect = {
  kind: "outbox",
  event: "m21.supply_request.status_changed",
};

const KIT_KINDS: ReadonlySet<SupplyRequestKind> = new Set([
  "comfort_kit_deploy",
  "comfort_kit_replenish",
]);

/** §2.2 — is this one of the two kit kinds (the `returned` branch and the M13 events)? */
export function isKitKind(kind: SupplyRequestKind): boolean {
  return KIT_KINDS.has(kind);
}

/**
 * §2.2 — apply one event. Throws `M21_INVALID_STATUS_TRANSITION` when the edge does not exist for this
 * (status, kind, transition), so a redelivered worker message or a racing second coordinator lands on a 409
 * rather than a silent no-op write (§7.2's two-coordinator race).
 */
export function transitionSupplyRequest(
  state: SupplyRequestLifecycleState,
  kind: SupplyRequestKind,
  event: SupplyRequestEvent,
): SupplyRequestTransitionResult {
  const edge = resolveTransition(state, kind, event.type as SupplyRequestTransition);
  if (edge === null) {
    // Terminal gets its own code: "this request finished three weeks ago" is a different operator
    // conversation from "you cannot skip vendor assignment", and M11's cascade branches on it (§7.7).
    if (isTerminalSupplyStatus(state)) {
      throw new SupplyStateError(
        "M21_REQUEST_ALREADY_TERMINAL",
        `supply request is already ${state}; '${event.type}' cannot be applied`,
      );
    }
    throw new SupplyStateError(
      "M21_INVALID_STATUS_TRANSITION",
      `'${event.type}' is not legal from '${state}' for a '${kind}' request`,
    );
  }

  switch (event.type) {
    case "assignVendor": {
      require_(
        isVendorAssignmentCoherent(event.resolved),
        "M21_ROUTING_VENDOR_INCOHERENT",
        `fulfillment mode '${event.resolved.assignedFulfillmentMode}' is incompatible with assignedVendorId=${String(event.resolved.assignedVendorId)}`,
      );
      if (event.resolved.assignedVendorId !== null) {
        require_(
          event.vendorActive === true,
          "M21_VENDOR_NOT_ACTIVE",
          `vendor ${event.resolved.assignedVendorId} is not active for this org`,
        );
      }
      return result(state, event.type, edge.to, [
        { kind: "audit" },
        { kind: "freeze_routing", resolved: event.resolved },
        STATUS_CHANGED,
      ]);
    }

    case "placeOrderWithVendor": {
      require_(
        event.vendorOrderReference.trim().length > 0,
        "M21_VENDOR_ORDER_REFERENCE_REQUIRED",
        "an order placed with a vendor (or assembled at the hub) must carry its reference",
      );
      const effects: SupplySideEffect[] = [
        { kind: "record_vendor_order", vendorOrderReference: event.vendorOrderReference },
        { kind: "set_timestamp", field: "ordered_at", at: event.at },
      ];
      if (isKitKind(kind)) {
        // §2.5 — the dispatch row is created in the SAME transaction as this transition. If its insert
        // fails, the whole transition rolls back and the request stays in `vendor_assigned`.
        require_(
          (event.dispatchLineCount ?? 0) > 0,
          "M21_DISPATCH_CONTENTS_EMPTY",
          "a comfort-kit order must dispatch at least one medication line",
        );
        effects.push(
          { kind: "create_dispatch", lineCount: event.dispatchLineCount as number },
          { kind: "set_dispatch_status", status: "dispatched" },
          { kind: "outbox", event: "m21.comfort_kit.dispatched" },
          { kind: "request_document", documentKind: "bill_of_lading" },
        );
      }
      effects.push(STATUS_CHANGED, {
        kind: "outbox",
        event: "m21.supply_request.document_requested",
      });
      return result(state, event.type, edge.to, withAudit(effects));
    }

    case "vendorConfirmedShipment": {
      require_(
        event.trackingNumber.trim().length > 0 && event.carrier.trim().length > 0,
        "M21_SHIPMENT_TRACKING_REQUIRED",
        "a shipment confirmation must carry both a tracking number and a carrier",
      );
      return result(
        state,
        event.type,
        edge.to,
        withAudit([
          {
            kind: "record_shipment",
            trackingNumber: event.trackingNumber,
            carrier: event.carrier,
          },
          { kind: "set_timestamp", field: "shipped_at", at: event.at },
          STATUS_CHANGED,
        ]),
      );
    }

    case "confirmDeliveryAtAddress": {
      const a = event.attestation;
      require_(
        a.deliveredByMembershipId.length > 0 && a.deliveredAt.length > 0,
        "M21_COURIER_ATTESTATION_REQUIRED",
        "delivery requires a courier attestation (who, when, how) — it is asked about long after the row goes terminal",
      );
      const effects: SupplySideEffect[] = [
        { kind: "record_courier_attestation", attestation: a },
        { kind: "set_timestamp", field: "delivered_at", at: a.deliveredAt },
        STATUS_CHANGED,
        { kind: "outbox", event: "m21.supply_request.delivered" },
      ];
      if (isKitKind(kind)) {
        // §2.5 — the kit reached the patient. M13 builds its deployment (deploy) or tops up its drawdowns
        // (replenish) from the event; the dispatch row moves to `deployed_at_patient` either way.
        effects.push(
          { kind: "set_dispatch_status", status: "deployed_at_patient" },
          {
            kind: "outbox",
            event:
              kind === "comfort_kit_deploy"
                ? "m21.comfort_kit.deployed_at_patient"
                : "m21.comfort_kit.replenished",
          },
        );
      }
      return result(state, event.type, edge.to, withAudit(effects));
    }

    case "caregiverOrPatientConfirmsReceipt": {
      if (event.actor === "system_auto_confirm") {
        require_(
          event.deliveredAt !== undefined &&
            isReceivedConfirmAutoDue(new Date(event.deliveredAt), new Date(event.at)),
          "M21_AUTO_CONFIRM_WINDOW_NOT_ELAPSED",
          "the 72-hour caregiver-confirmation grace has not expired; a system auto-confirm now would manufacture a receipt nobody gave",
        );
      }
      return result(
        state,
        event.type,
        edge.to,
        withAudit([
          { kind: "record_received_confirmation", actor: event.actor, at: event.at },
          { kind: "set_timestamp", field: "received_confirmed_at", at: event.at },
          STATUS_CHANGED,
        ]),
      );
    }

    case "completeRequest": {
      if (!autoCompletesOnReceipt(kind, event.rentalCadence)) {
        if (isKitKind(kind)) {
          require_(
            event.m13Acked === true,
            "M21_KIT_COMPLETION_REQUIRES_M13_ACK",
            "a comfort-kit request completes only once M13 acknowledges the deployment / replenishment",
          );
        } else {
          require_(
            event.orderDiscontinued === true,
            "M21_RENTAL_COMPLETION_REQUIRES_DISCONTINUATION",
            "a monthly rental stays open for the rental life; it completes only when M11 discontinues the order",
          );
        }
      }
      return result(
        state,
        event.type,
        edge.to,
        withAudit([{ kind: "set_timestamp", field: "completed_at", at: event.at }, STATUS_CHANGED]),
      );
    }

    case "cancel": {
      require_(
        event.reason.trim().length > 0,
        "M21_CANCELLATION_REASON_REQUIRED",
        "a cancellation without a recorded reason is not a cancellation, it is a disappearance",
      );
      return result(
        state,
        event.type,
        edge.to,
        withAudit([
          {
            kind: "record_cancellation",
            reason: event.reason,
            requiredVendorConfirmation: false,
            at: event.at,
          },
          { kind: "set_timestamp", field: "cancelled_at", at: event.at },
          STATUS_CHANGED,
          { kind: "outbox", event: "m21.supply_request.cancelled" },
        ]),
      );
    }

    case "requestCancellation": {
      require_(
        event.reason.trim().length > 0,
        "M21_CANCELLATION_REASON_REQUIRED",
        "a cancellation without a recorded reason is not a cancellation, it is a disappearance",
      );
      // No `cancelled` event yet — the vendor has not answered, and telling M11 the order was released
      // while a hospital bed is still on the truck is exactly the lie the two-phase path exists to avoid.
      return result(
        state,
        event.type,
        edge.to,
        withAudit([
          { kind: "set_timestamp", field: "cancellation_pending_at", at: event.at },
          STATUS_CHANGED,
        ]),
      );
    }

    case "vendorConfirmedCancellation":
      return result(
        state,
        event.type,
        edge.to,
        withAudit([
          {
            kind: "record_cancellation",
            reason: event.reason,
            requiredVendorConfirmation: true,
            at: event.at,
          },
          { kind: "set_timestamp", field: "cancelled_at", at: event.at },
          STATUS_CHANGED,
          { kind: "outbox", event: "m21.supply_request.cancelled" },
        ]),
      );

    case "vendorRefusedCancellation": {
      // The edge table offers `cancellation_pending → ordered` AND `→ in_transit` under ONE transition name,
      // so `resolveTransition` (first match) cannot pick between them — only the caller knows which state
      // the row actually left. Restoring the wrong one fabricates a shipment that never happened, or
      // un-ships one that did.
      const restoreEdge = allowedTransitions(state, kind).find(
        (e) => e.transition === "vendorRefusedCancellation" && e.to === event.restoreTo,
      );
      require_(
        restoreEdge !== undefined,
        "M21_CANCELLATION_RESTORE_STATE_INVALID",
        `a refusal must restore the pre-cancellation state; '${String(event.restoreTo)}' is not a legal target from '${state}'`,
      );
      return result(
        state,
        event.type,
        event.restoreTo,
        withAudit([
          STATUS_CHANGED,
          { kind: "alert", alert: "m21.supply_request.vendor_cancellation_refused" },
        ]),
      );
    }

    case "initiateReturn":
      return result(
        state,
        event.type,
        edge.to,
        withAudit([{ kind: "create_return", returnDueAt: event.at }, STATUS_CHANGED]),
      );

    case "completeReturnReconciliation": {
      require_(
        event.returnReconciled,
        "M21_RETURN_NOT_RECONCILED",
        "the request completes only once its comfort_kit_return row reached 'reconciled' with the per-line accounting written",
      );
      return result(
        state,
        event.type,
        edge.to,
        withAudit([{ kind: "set_timestamp", field: "completed_at", at: event.at }, STATUS_CHANGED]),
      );
    }
  }
}

/**
 * §2.2 — resolve which edge a `vendorRefusedCancellation` should restore to. The row's pre-cancellation
 * state is NOT stored (the transition overwrote `status`), so it is derived from the shipment record:
 * `shipped_at` set means the row had already reached `in_transit`.
 */
export function restoreStateAfterRefusal(
  shippedAt: IsoInstant | null,
): Extract<SupplyRequestStatus, "ordered" | "in_transit"> {
  return shippedAt === null ? "ordered" : "in_transit";
}

// ── §2.10 asynchronous detectors (the §4.6 workers' deciders) ─────────────────────────────────────────

/** What the §4.6 monitor found on one in-flight request. `null` = nothing to say. */
export type SupplyRequestMonitorFinding =
  | { readonly kind: "vendor_confirmation_overdue"; readonly hoursElapsed: number }
  | { readonly kind: "delivery_overdue"; readonly hoursLate: number }
  | { readonly kind: "received_confirm_auto_due" };

export interface SupplyRequestMonitorInput {
  readonly status: SupplyRequestStatus;
  readonly orderedAt: IsoInstant | null;
  readonly deliveredAt: IsoInstant | null;
  /** `data.deliveryWindowLatest`, when the request declared one. */
  readonly deliveryWindowLatest: IsoInstant | null;
  /** Tenant-tightened window; the platform ceiling is applied inside `isVendorConfirmationOverdue`. */
  readonly vendorConfirmationWindowHours?: number;
}

const MS_PER_HOUR = 3_600_000;

/**
 * §2.10 — the three time-based findings on a live request, evaluated at `asOf`.
 *
 * All three are ADVISORY: each raises an alert and none moves the row. A supply request that is late is
 * still a supply request, and auto-transitioning it on lateness would erase the very evidence the supply
 * team needs to chase the vendor. The one exception is the 72h receipt fallback, which the caller applies
 * as a real `caregiverOrPatientConfirmsReceipt` event with the `system_auto_confirm` actor.
 */
export function detectSupplyRequestFindings(
  input: SupplyRequestMonitorInput,
  asOf: Date,
): ReadonlyArray<SupplyRequestMonitorFinding> {
  const findings: SupplyRequestMonitorFinding[] = [];

  if (input.status === "ordered" && input.orderedAt !== null) {
    const orderedAt = new Date(input.orderedAt);
    if (isVendorConfirmationOverdue(orderedAt, asOf, input.vendorConfirmationWindowHours)) {
      findings.push({
        kind: "vendor_confirmation_overdue",
        hoursElapsed: Math.floor((asOf.getTime() - orderedAt.getTime()) / MS_PER_HOUR),
      });
    }
  }

  if (input.status === "in_transit" && input.deliveryWindowLatest !== null) {
    const latest = new Date(input.deliveryWindowLatest);
    if (asOf.getTime() > latest.getTime()) {
      findings.push({
        kind: "delivery_overdue",
        hoursLate: Math.floor((asOf.getTime() - latest.getTime()) / MS_PER_HOUR),
      });
    }
  }

  if (input.status === "delivered" && input.deliveredAt !== null) {
    if (isReceivedConfirmAutoDue(new Date(input.deliveredAt), asOf)) {
      findings.push({ kind: "received_confirm_auto_due" });
    }
  }

  return findings;
}
