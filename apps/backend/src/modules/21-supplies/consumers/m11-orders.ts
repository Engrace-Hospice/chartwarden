// apps/backend/src/modules/21-supplies/consumers/m11-orders.ts — M21-T04 (§4.5.1, §7.1, §7.7).
//
// M21's subscribers to Module 11's supply cascade — the handshake that CLOSES M11's Wave-E supply
// deny-stub. M11 owns the RULE that a signed `dme` / `supply` / `comfort_kit` order wants fulfilling; M21
// owns the fulfillment. Neither imports the other: the whole contract is three outbox event names, read
// here off `M21_SUBSCRIBED_EVENT_NAMES` in `@wardenx/types` (the shared source of truth, so an upstream
// rename breaks the build instead of orphaning a handler).
//
// PHASE-1 PURE DECISION CORE — the M7 `apply-idg-decision` / M16 `m6-eligibility` precedent. What ships
// here is the three deciders: given the parsed payload plus the facts the worker resolved (`./order-context`
// reads them through M11's `OrderProvider` and M6's `AdmissionStatusReader`), each returns a descriptor of
// what to write. The live outbox binding + the transactional insert land with the §4.6 workers alongside
// the M21-T05 service layer.
//
// WHY THE CASCADE IS A READ-BACK, NOT A PROJECTION. M11's payload is `{ orderId, kind, supplyDetail, … }`:
// its aggregate is the order, so the payload says WHAT was ordered, not WHO for. Every M21 PHI row needs
// `patient_id` + `admission_id` + `provider_entity_id` + `location_id` NOT NULL, so the consumer reads the
// order back through the seam. That is the same shape M16-T03 landed on when M6's merged event turned out
// to carry no death instant — an event name is a trigger, not a data feed.
//
// FAIL DIRECTION, chosen per fact rather than per consumer:
//   • order unresolvable / no serving Location → DEAD-LETTER (`M21_SOURCE_ORDER_UNRESOLVED`,
//     `M21_SERVING_LOCATION_UNRESOLVED`). Both are configuration or ordering failures the M11 outbox will
//     retry past; a row anchored to a guessed Location misroutes a controlled-substance dispatch.
//   • patient died or was discharged between M11's emit and M21's consume → NOT a dead-letter. §7.1 is
//     explicit: create the row, then immediately cancel it with the reason recorded, so M11 gets its
//     release event and the audit trail shows a supply request that existed and was stood down. Dropping
//     the delivery would leave M11's order waiting on a fulfillment that will never arrive.
//   • death-vs-live-discharge indeterminate → the row still cancels; only the REASON degrades. A wrong
//     cancellation reason is a reporting nuisance; a missing cancellation is a stranded order.
import { canTransition, isTerminalSupplyStatus } from "@wardenx/supplies";
import type {
  AdmissionId,
  AdmissionStatusValue,
  IsoInstant,
  LocalDate,
  LocationId,
  M21SubscribedEventName,
  OrderRecordId,
  OrderStatus,
  PatientId,
  ProviderEntityId,
  SupplyRequestId,
  SupplyRequestKind,
  SupplyRequestStatus,
} from "@wardenx/types";
import { SupplyStateError } from "../lifecycle/index";

// ── the three subscribed M11 event names + their payloads (§4.5.1) ───────────────────────────────────

/** §4.5.1 — a signed supply-kind order wants fulfilling. Typed off the frozen subscription list. */
export const M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT: Extract<
  M21SubscribedEventName,
  "m11.order.supply_fulfillment_requested"
> = "m11.order.supply_fulfillment_requested";

/** §4.5.1 / §7.7 — the M11 order was discontinued while its fulfillment was in flight. */
export const M11_SUPPLY_CANCELLATION_REQUESTED_EVENT: Extract<
  M21SubscribedEventName,
  "m11.order.supply_cancellation_requested"
> = "m11.order.supply_cancellation_requested";

/** §4.5.1 / §2.2 — the broad close-out fan-out. M21 reads it for exactly one thing: the DME monthly-rental
 *  completion, which §2.2 gates on M11 discontinuing the order rather than on a delivery. */
export const M11_ORDER_DISCONTINUED_EVENT: Extract<
  M21SubscribedEventName,
  "m11.order.discontinued"
> = "m11.order.discontinued";

/** The M11 order kinds that cascade into M21 (`m11.order.supply_fulfillment_requested.kind`). */
export type M11SupplyOrderKind = "dme" | "supply" | "comfort_kit";

/** The `m11.order.supply_fulfillment_requested` payload (apps/backend/src/modules/11-orders/
 *  events-by-m11.ts). `supplyDetail` is structurally open — M11 owns its per-kind shape, and M21 validates
 *  it against the matching D1 TypeBox in `@wardenx/supplies` before writing `supply_request.data`. */
export interface M11SupplyFulfillmentRequestedPayload {
  readonly orderId: OrderRecordId;
  readonly kind: M11SupplyOrderKind;
  readonly supplyDetail: unknown;
  readonly preferredDeliveryWindow?: string | null;
  readonly deploymentSite?: string | null;
}

/** The `m11.order.supply_cancellation_requested` payload. `originalSupplyRequestRef` is M11's own record of
 *  what it cascaded into; M21 keys on `orderId` regardless, because M11's ref can be stale. */
export interface M11SupplyCancellationRequestedPayload {
  readonly orderId: OrderRecordId;
  readonly originalSupplyRequestRef?: SupplyRequestId | null;
}

/** The `m11.order.discontinued` payload. */
export interface M11OrderDiscontinuedPayload {
  readonly orderId: OrderRecordId;
  readonly discontinuationId: string;
  readonly reason: string;
  readonly actorMembershipId: string | null;
  readonly effectiveAt: IsoInstant;
}

// ── resolved facts (see ./order-context for how they are read) ───────────────────────────────────────

/** The M11 order behind the cascade, projected from `OrderProvider.getOrder`. */
export interface SupplyOrderContext {
  readonly orderId: OrderRecordId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly orderStatus: OrderStatus;
}

/** The M6 admission behind the order, projected from `AdmissionStatusReader.getAdmissionSummary`. */
export interface SupplyAdmissionContext {
  readonly providerEntityId: ProviderEntityId;
  readonly status: AdmissionStatusValue;
  readonly dischargedAt: LocalDate | null;
  /**
   * §7.1 — the Location the agency fills this patient's supplies from (`supply_request.location_id`,
   * NOT NULL). F-166 (#248): this is `AdmissionSummary.locationId` (task-11's M6 activation-siting
   * anchor — the same fact `m6-admission-activated.ts` denormalizes onto `patient.location_id`),
   * already returned by the `getAdmissionSummary` call this context is projected from. `null` when the
   * admission has not yet been sited (draft, or activated with no location port bound) — the decider
   * dead-letters on that, not this reader.
   */
  readonly locationId: LocationId | null;
  /**
   * Whether M6's census shows this admission as a DEATH discharge. `null` = could not be determined, which
   * only degrades the cancellation reason (see the file header). Resolved by a narrow window read, because
   * `AdmissionSummary.status` says `discharged` for a death and a live discharge alike.
   */
  readonly deathDischarge: boolean | null;
}

/** Everything the fulfillment-intake worker reads before it can decide, surfaced as data so the decider
 *  stays pure. */
export interface SupplyFulfillmentIntakeFacts {
  /** A `supply_request` already exists for this `sourceOrderId` — the outbox-retry idempotency check. */
  readonly existingRequestId: SupplyRequestId | null;
  /** `OrderProvider.getOrder`; null when the order is not visible under this tenant. */
  readonly order: SupplyOrderContext | null;
  /** `AdmissionStatusReader`; null when the admission is not visible. */
  readonly admission: SupplyAdmissionContext | null;
  /** The Location the agency will fill from (`supply_request.location_id`, NOT NULL). */
  readonly servingLocationId: LocationId | null;
}

/** The §7.1 cancellation reasons the pre-dispatch cascade records. Frozen tokens, not free text — §8.1
 *  reads them as a category and M11 branches on them. */
export type SupplyPreDispatchCancellationReason =
  | "patient_deceased_pre_dispatch"
  | "patient_discharged_live_pre_dispatch"
  | "admission_closed_pre_dispatch";

/** What the `m11.order.supply_fulfillment_requested` decider resolved. */
export type SupplyFulfillmentIntakeAction =
  /** A redelivery for an order that already cascaded — no write, no re-emit (§7.1 edge 2). */
  | { readonly kind: "idempotent_skip"; readonly supplyRequestId: SupplyRequestId }
  /** Insert the `requested` row and emit `status_changed` with `fromStatus: null` (§7.1 acceptance 1/4). */
  | { readonly kind: "open_request"; readonly draft: SupplyRequestDraft }
  /** §7.1 edges 3/4 — insert, then cancel in the SAME transaction. Two `status_changed` emits, because
   *  both transitions really happened and M33's funnel must not show a request that was never `requested`. */
  | {
      readonly kind: "open_and_cancel_request";
      readonly draft: SupplyRequestDraft;
      readonly cancellationReason: SupplyPreDispatchCancellationReason;
    };

/** The row the intake inserts. Every tenancy column is non-null by construction — the decider refuses to
 *  produce a draft it could not fully anchor. */
export interface SupplyRequestDraft {
  readonly kind: SupplyRequestKind;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly sourceOrderId: OrderRecordId;
  readonly sourceReplenishmentEventId: null;
  readonly supplyDetail: unknown;
  readonly preferredDeliveryWindow: string | null;
  readonly deploymentSite: string | null;
}

/**
 * §2.1 / D1 — map M11's order kind onto M21's request kind.
 *
 * M11 signs ONE `comfort_kit` order kind; M21 splits it in two. Only `comfort_kit_deploy` can come from an
 * order — `comfort_kit_replenish` is born from M13's drawdown, which has no M11 order behind it, and that
 * asymmetry is exactly why the mapping is a function rather than a cast.
 */
export function supplyRequestKindForOrderKind(kind: M11SupplyOrderKind): SupplyRequestKind {
  return kind === "comfort_kit" ? "comfort_kit_deploy" : kind;
}

/** §7.1 — the admission statuses that mean "there is no longer anyone at this address to deliver to". */
const POST_CARE_ADMISSION_STATUSES: ReadonlySet<AdmissionStatusValue> = new Set([
  "discharged",
  "bereavement",
  "closed",
]);

/** §7.1 — pick the cancellation reason from the admission posture. `bereavement`/`closed` are post-death
 *  by construction (M6 only moves an admission there after a death discharge), so the census read only has
 *  to discriminate the ambiguous `discharged`. */
function preDispatchCancellationReason(
  admission: SupplyAdmissionContext,
): SupplyPreDispatchCancellationReason {
  if (admission.status === "bereavement") return "patient_deceased_pre_dispatch";
  if (admission.status === "closed") return "admission_closed_pre_dispatch";
  if (admission.deathDischarge === true) return "patient_deceased_pre_dispatch";
  if (admission.deathDischarge === false) return "patient_discharged_live_pre_dispatch";
  // Indeterminate. `admission_closed_pre_dispatch` is the honest token: it says the admission ended
  // without claiming to know how, which is better than asserting a death or a survival we did not read.
  return "admission_closed_pre_dispatch";
}

/**
 * §7.1 — decide what an `m11.order.supply_fulfillment_requested` delivery does.
 *
 * ORDERING is deliberate: idempotency first (a redelivery must never re-emit), then the two fail-closed
 * anchors, then the post-care posture. The posture check is LAST because a redelivered event for a patient
 * who has since died must still be an idempotent skip, not a second cancellation.
 *
 * Throws `M21_SOURCE_ORDER_UNRESOLVED` / `M21_SERVING_LOCATION_UNRESOLVED` (both 422) to dead-letter the
 * delivery for a human rather than write a request anchored to a guess.
 */
export function decideSupplyFulfillmentIntake(
  payload: M11SupplyFulfillmentRequestedPayload,
  facts: SupplyFulfillmentIntakeFacts,
): SupplyFulfillmentIntakeAction {
  if (facts.existingRequestId !== null) {
    return { kind: "idempotent_skip", supplyRequestId: facts.existingRequestId };
  }

  const order = facts.order;
  if (order === null) {
    throw new SupplyStateError(
      "M21_SOURCE_ORDER_UNRESOLVED",
      `OrderProvider resolved no order ${payload.orderId} for the supply cascade`,
    );
  }
  const admission = facts.admission;
  if (admission === null) {
    throw new SupplyStateError(
      "M21_SOURCE_ORDER_UNRESOLVED",
      `order ${payload.orderId} names admission ${order.admissionId}, which resolved to no summary`,
    );
  }
  if (facts.servingLocationId === null) {
    throw new SupplyStateError(
      "M21_SERVING_LOCATION_UNRESOLVED",
      `no serving Location resolved for order ${payload.orderId}; supply_request.location_id is NOT NULL`,
    );
  }

  const draft: SupplyRequestDraft = {
    kind: supplyRequestKindForOrderKind(payload.kind),
    patientId: order.patientId,
    admissionId: order.admissionId,
    providerEntityId: admission.providerEntityId,
    locationId: facts.servingLocationId,
    sourceOrderId: order.orderId,
    sourceReplenishmentEventId: null,
    supplyDetail: payload.supplyDetail,
    preferredDeliveryWindow: payload.preferredDeliveryWindow ?? null,
    deploymentSite: payload.deploymentSite ?? null,
  };

  if (POST_CARE_ADMISSION_STATUSES.has(admission.status)) {
    return {
      kind: "open_and_cancel_request",
      draft,
      cancellationReason: preDispatchCancellationReason(admission),
    };
  }
  return { kind: "open_request", draft };
}

// ── §7.7 the cancellation cascade ────────────────────────────────────────────────────────────────────

/** The live request the cancellation cascade found, keyed on `sourceOrderId`. */
export interface SupplyCancellationTarget {
  readonly supplyRequestId: SupplyRequestId;
  readonly kind: SupplyRequestKind;
  readonly status: SupplyRequestStatus;
}

/** The reason token the M11 cascade stamps on the cancellation. */
export const M11_CANCELLATION_CASCADE_REASON = "m11_cancellation_cascade" as const;

/** What the `m11.order.supply_cancellation_requested` decider resolved. */
export type SupplyCancellationCascadeAction =
  /**
   * No `supply_request` exists for this order. NOTHING is emitted: `cancel_no_op`'s payload requires a
   * `supplyRequestId` and inventing one to acknowledge a request that never existed would put a phantom id
   * in M11's order record. M11 already distinguishes this case — its own `originalSupplyRequestRef` is
   * null when it never saw a cascade land.
   */
  | { readonly kind: "no_match" }
  /** §2.2 pre-`ordered`: nothing was promised to anyone, so the row cancels immediately. */
  | {
      readonly kind: "cancel";
      readonly supplyRequestId: SupplyRequestId;
      readonly reason: typeof M11_CANCELLATION_CASCADE_REASON;
    }
  /** §2.2 post-`ordered`: the vendor has the order, so the cancellation is a REQUEST until they answer. */
  | {
      readonly kind: "request_cancellation";
      readonly supplyRequestId: SupplyRequestId;
      readonly reason: typeof M11_CANCELLATION_CASCADE_REASON;
    }
  /** A redelivery while the vendor's answer is still outstanding — do not re-ask. */
  | { readonly kind: "already_cancelling"; readonly supplyRequestId: SupplyRequestId }
  /** §7.7 step 4 — the row is past cancelling. Emit `cancel_no_op` so M11 learns the cascade ARRIVED. */
  | {
      readonly kind: "cancel_no_op";
      readonly supplyRequestId: SupplyRequestId;
      readonly terminalStatus: SupplyRequestStatus;
    };

/**
 * §7.7 — decide what an `m11.order.supply_cancellation_requested` delivery does.
 *
 * The cancellable/not-cancellable split is DERIVED from the §2.2 edge table (`canTransition`) rather than
 * restated as a status list. §7.7's prose lists `delivered | received_confirmed | completed | cancelled |
 * returned` as terminal, which is a wider set than the machine's own `isTerminalSupplyStatus` (that one is
 * `completed | cancelled` — `cancellation_pending` is deliberately NOT terminal because the vendor may yet
 * refuse). Reading the edge table keeps the two definitions from drifting: whatever the machine says has no
 * cancel edge is what M11 gets a no-op for.
 */
export function decideSupplyCancellationCascade(
  payload: M11SupplyCancellationRequestedPayload,
  target: SupplyCancellationTarget | null,
): SupplyCancellationCascadeAction {
  if (target === null) return { kind: "no_match" };
  void payload;

  if (target.status === "cancellation_pending") {
    return { kind: "already_cancelling", supplyRequestId: target.supplyRequestId };
  }
  if (canTransition(target.status, target.kind, "cancel")) {
    return {
      kind: "cancel",
      supplyRequestId: target.supplyRequestId,
      reason: M11_CANCELLATION_CASCADE_REASON,
    };
  }
  if (canTransition(target.status, target.kind, "requestCancellation")) {
    return {
      kind: "request_cancellation",
      supplyRequestId: target.supplyRequestId,
      reason: M11_CANCELLATION_CASCADE_REASON,
    };
  }
  return {
    kind: "cancel_no_op",
    supplyRequestId: target.supplyRequestId,
    terminalStatus: target.status,
  };
}

// ── §2.2 the DME monthly-rental close-out ────────────────────────────────────────────────────────────

/** The request an `m11.order.discontinued` might close out. */
export interface SupplyDiscontinuationTarget extends SupplyCancellationTarget {
  /** DME only; `null` for the other kinds. A monthly rental is the one cadence that waits for M11. */
  readonly rentalCadence: "monthly" | "one_time_purchase" | null;
}

/** What the `m11.order.discontinued` decider resolved. */
export type SupplyDiscontinuationAction =
  /** Nothing open for this order, or the row is not the rental that waits on a discontinuation. */
  | { readonly kind: "no_op" }
  /** §2.2 — fire `completeRequest` with `orderDiscontinued: true`; the rental's HCPCS accrual stops here. */
  | { readonly kind: "complete_rental"; readonly supplyRequestId: SupplyRequestId };

/**
 * §2.2 — decide what an `m11.order.discontinued` delivery does.
 *
 * M21 subscribes to M11's broad close-out fan-out for exactly ONE reason: a `monthly` DME rental stays open
 * for the whole rental life so the recurring HCPCS line has a live row to accrue against, and §2.2 gates its
 * completion on M11 discontinuing the order rather than on a delivery (`M21_RENTAL_COMPLETION_REQUIRES_
 * DISCONTINUATION`). Every other kind self-completes on receipt and ignores this event — which is why the
 * default here is `no_op` and not an error: a discontinued `supply` order whose box already arrived is a
 * perfectly ordinary sequence, not a fault.
 */
export function decideOrderDiscontinued(
  payload: M11OrderDiscontinuedPayload,
  target: SupplyDiscontinuationTarget | null,
): SupplyDiscontinuationAction {
  void payload;
  if (target === null) return { kind: "no_op" };
  if (isTerminalSupplyStatus(target.status)) return { kind: "no_op" };
  if (target.kind !== "dme" || target.rentalCadence !== "monthly") return { kind: "no_op" };
  if (!canTransition(target.status, target.kind, "completeRequest")) return { kind: "no_op" };
  return { kind: "complete_rental", supplyRequestId: target.supplyRequestId };
}
