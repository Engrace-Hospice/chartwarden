// @chartwarden/supplies — the §2.2 / D2 supply-request lifecycle as pure data.
//
// The XState actor (`statemachines/supply-request.machine.ts`, M21-T03) is BUILT FROM this table rather
// than restating it, so the graph the machine runs and the graph the tests and the UI timeline read are
// the same object. PURE — no IO, no clock.

import type { SupplyRequestKind, SupplyRequestStatus } from "@chartwarden/types";

import { KIT_REQUEST_KINDS, SUPPLY_REQUEST_TERMINAL_STATUSES } from "./policy";

/** The §2.2 transition names. One per labelled edge in the state diagram. */
export type SupplyRequestTransition =
  | "assignVendor"
  | "placeOrderWithVendor"
  | "vendorConfirmedShipment"
  | "confirmDeliveryAtAddress"
  | "caregiverOrPatientConfirmsReceipt"
  | "completeRequest"
  | "requestCancellation"
  | "vendorConfirmedCancellation"
  | "vendorRefusedCancellation"
  | "cancel"
  | "initiateReturn"
  | "completeReturnReconciliation";

export interface SupplyRequestEdge {
  readonly transition: SupplyRequestTransition;
  readonly from: SupplyRequestStatus;
  readonly to: SupplyRequestStatus;
  /** Undefined = every kind. Present = only these kinds may take the edge. */
  readonly kinds?: readonly SupplyRequestKind[];
  /** Why the edge exists, for the survey-reconstruction reader. */
  readonly note: string;
}

const KIT_KINDS: readonly SupplyRequestKind[] = KIT_REQUEST_KINDS;

/**
 * §2.2 — the complete edge set.
 *
 * Two shapes deserve reading twice:
 *
 *  1. **Cancellation is two-phase after `ordered`.** `cancel` only reaches `cancelled` directly from the
 *     three pre-shipment states. From `ordered` and `in_transit` the row goes to `cancellation_pending`
 *     and waits for the vendor, because a DME already on the truck cannot be un-shipped by our writing a
 *     status. `vendorRefusedCancellation` walks the row BACK to where it was — the refusal is the vendor's
 *     answer, not an error state of ours.
 *
 *  2. **`returned` is kit-only.** A rental bed comes back through the M11 discontinuation + rental-pickup
 *     path, not the §2.6 controlled-substance chain of custody. Giving DME a `returned` edge would let a
 *     bed pickup enter the reconciliation pipeline that exists to count morphine.
 */
export const SUPPLY_REQUEST_EDGES: readonly SupplyRequestEdge[] = [
  {
    transition: "assignVendor",
    from: "requested",
    to: "vendor_assigned",
    note: "D4 routing rule resolved and recorded immutably to routing_rule_resolved_jsonb",
  },
  {
    transition: "placeOrderWithVendor",
    from: "vendor_assigned",
    to: "ordered",
    note: "Phase-1 portal/email/fax; Phase-2 EDI 850 → 855. Kit kinds also create the dispatch row here.",
  },
  {
    transition: "vendorConfirmedShipment",
    from: "ordered",
    to: "in_transit",
    note: "Phase-1 manual entry of tracking/carrier; Phase-2 EDI 856 ASN",
  },
  {
    transition: "confirmDeliveryAtAddress",
    from: "in_transit",
    to: "delivered",
    note: "D7 courier attestation required; kit kinds emit m21.comfort_kit.deployed_at_patient here",
  },
  {
    transition: "caregiverOrPatientConfirmsReceipt",
    from: "delivered",
    to: "received_confirmed",
    note: "explicit confirm, or the 72h system_auto_confirm fallback with the distinguishing actor value",
  },
  {
    transition: "completeRequest",
    from: "received_confirmed",
    to: "completed",
    note: "auto for one-shot DME/supply; kit kinds wait on the M13 ack; rental DME waits on m11.order.discontinued",
  },
  {
    transition: "cancel",
    from: "requested",
    to: "cancelled",
    note: "pre-vendor cancellation is immediate — nothing was promised to anyone",
  },
  {
    transition: "cancel",
    from: "vendor_assigned",
    to: "cancelled",
    note: "pre-order cancellation is immediate — the vendor was chosen but not told",
  },
  {
    transition: "requestCancellation",
    from: "ordered",
    to: "cancellation_pending",
    note: "the vendor has the order; cancellation is a request until they answer",
  },
  {
    transition: "requestCancellation",
    from: "in_transit",
    to: "cancellation_pending",
    note: "courier-recall path; rare",
  },
  {
    transition: "vendorConfirmedCancellation",
    from: "cancellation_pending",
    to: "cancelled",
    note: "vendor accepted; cancellation_vendor_response_jsonb records the answer",
  },
  {
    transition: "vendorRefusedCancellation",
    from: "cancellation_pending",
    to: "ordered",
    note: "refusal returns the row to its real state and fires the vendor_cancellation_refused alert",
  },
  {
    transition: "vendorRefusedCancellation",
    from: "cancellation_pending",
    to: "in_transit",
    note: "same refusal path for a row that was already shipping",
  },
  {
    transition: "initiateReturn",
    from: "delivered",
    to: "returned",
    kinds: KIT_KINDS,
    note: "D8 return cascade from m13.comfort_kit.return_required",
  },
  {
    transition: "initiateReturn",
    from: "received_confirmed",
    to: "returned",
    kinds: KIT_KINDS,
    note: "same cascade once receipt was confirmed",
  },
  {
    transition: "completeReturnReconciliation",
    from: "returned",
    to: "completed",
    kinds: KIT_KINDS,
    note: "the comfort_kit_return row reached 'reconciled'; per-line accounting has been emitted",
  },
] as const;

const TERMINAL: ReadonlySet<SupplyRequestStatus> = new Set(SUPPLY_REQUEST_TERMINAL_STATUSES);

/** §2.2 — `completed` and `cancelled` only. `cancellation_pending` is NOT terminal: the vendor may yet
 *  refuse, walking the row back to a live state. M11 asks this before issuing a cancellation cascade. */
export function isTerminalSupplyStatus(status: SupplyRequestStatus): boolean {
  return TERMINAL.has(status);
}

/** Every edge legal from `status` for a request of `kind`. */
export function allowedTransitions(
  status: SupplyRequestStatus,
  kind: SupplyRequestKind,
): readonly SupplyRequestEdge[] {
  return SUPPLY_REQUEST_EDGES.filter(
    (e) => e.from === status && (e.kinds === undefined || e.kinds.includes(kind)),
  );
}

/** Resolve one transition. Returns null when the edge does not exist for this (status, kind, transition) —
 *  the caller turns that into a 409, never a silent no-op write. */
export function resolveTransition(
  status: SupplyRequestStatus,
  kind: SupplyRequestKind,
  transition: SupplyRequestTransition,
): SupplyRequestEdge | null {
  return allowedTransitions(status, kind).find((e) => e.transition === transition) ?? null;
}

export function canTransition(
  status: SupplyRequestStatus,
  kind: SupplyRequestKind,
  transition: SupplyRequestTransition,
): boolean {
  return resolveTransition(status, kind, transition) !== null;
}

/**
 * §2.2 — does reaching `received_confirmed` auto-complete this request?
 *
 * A monthly rental deliberately does NOT: the request stays open for the whole rental life so the recurring
 * HCPCS line has a live row to accrue against, and completes only when M11 discontinues the order. Reading
 * a still-open rental as a stalled request is the classic misread this predicate exists to prevent.
 */
export function autoCompletesOnReceipt(
  kind: SupplyRequestKind,
  rentalCadence: "monthly" | "one_time_purchase" | null,
): boolean {
  if (kind === "comfort_kit_deploy" || kind === "comfort_kit_replenish") return false;
  if (kind === "dme") return rentalCadence !== "monthly";
  return true;
}
