// @wardenx/orders — §2.2 D2 order lifecycle state machine (M11-T03). Pure, IO-free.
//
// The order aggregate lifecycle (§2.2):
//
//   draft ─requestSignature→ pending_signature ─sign→ active ─complete→ completed
//     │                          │  │  └recordVerbal→ verbal_pending ─sign→ active
//     │                          │  └withdraw→ discontinued        └expire→ expired_unsigned
//     └discardDraft→ discontinued└(cosign overlay blocks sign until attached)
//   active ─discontinue→ discontinued ;  {pending_signature|verbal_pending|active} ─cascade→ discontinued
//
// Pure transition function (the M8 lifecycle convention): it validates the event is legal from the current
// state (the §2.2 graph — nothing transitions on a string match), runs the enumerated guards (failures
// raise the precise §2.2 code via OrderStateError), and returns the new state + the §2.6/§2.8 in-
// transaction side-effect list the service executes. No IO; every fact a guard needs (required-fields
// complete, cosign attached, deadline reached, actor authority) is resolved upstream and passed in. The
// discipline / signer / cosign predicates live in their own modules (./discipline-can-order,
// ./signer-eligible, ./cosign-rules) and are composed by the service alongside this machine.
import type { OrderKind, OrderStatus, M11EventName, OrderDiscontinuationReason } from "@wardenx/types";
import { KIND_CATALOG } from "../catalog";
import { type OrderSideEffect, type OrderTransitionResult, result } from "./effects";
import { OrderStateError, require_ } from "./errors";

export type OrderState = OrderStatus;

/** The §2.2 order lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type OrderEvent =
  | {
      readonly type: "requestSignature";
      /** §2.2 — the per-kind required `data` fields are complete (per-kind TypeBox lands M11-T06). */
      readonly requiredFieldsComplete: boolean;
      /** §2.2 cosign overlay — does this order require a cosignature before it may be signed (§2.5). */
      readonly cosignRequired: boolean;
      /** The cosigner role to notify when `cosignRequired` (drives `m11.order.cosign_requested`). */
      readonly cosignerRoleNeeded?: "rn_case_manager" | "clinical_supervisor" | "medical_director";
    }
  | {
      readonly type: "discardDraft";
      /** §2.2 — the actor is the drafter or a supervisor. */
      readonly actorMayDiscard: boolean;
      /** §2.2 — the draft is referenced by another `order_record` (e.g. as a `replaces_order_id` target). */
      readonly hasExternalReferences: boolean;
    }
  | {
      readonly type: "sign";
      readonly kind: OrderKind;
      /** §2.2 cosign overlay — the order's cosignature has been attached (`cosign_status='attached'`). */
      readonly cosignAttached: boolean;
      /** §2.2 — this signature is being applied on behalf of the named practitioner (emits the audit event). */
      readonly onBehalf: boolean;
    }
  | {
      readonly type: "recordVerbal";
      readonly kind: OrderKind;
      /** §2.3 — the recording RN attested to the verbal communication (≥ 100 chars; denylisted). */
      readonly attestationRecorded: boolean;
      /** §2.3 — the recording actor is RN+ holding `orders.verbal.record`. */
      readonly recorderEligible: boolean;
    }
  | {
      readonly type: "withdraw";
      /** §2.2 — the actor is the drafter, supervisor, or signer. */
      readonly actorMayWithdraw: boolean;
    }
  | {
      readonly type: "expire";
      /** §2.2 — fired by the system `verbal-timer` worker (not a human actor). */
      readonly isSystemActor: boolean;
      /** §2.2 — `now() >= deadline_at`. */
      readonly deadlineReached: boolean;
    }
  | {
      readonly type: "complete";
      /** §2.2 — the kind-specific completion criterion is met (auto for one-shot; manual for ongoing). */
      readonly criterionMet: boolean;
    }
  | {
      readonly type: "discontinue";
      readonly kind: OrderKind;
      readonly reason: OrderDiscontinuationReason;
      /** §2.6 — a downstream M21 fulfillment is in flight (emits `supply_cancellation_requested`). */
      readonly fulfillmentInFlight: boolean;
    }
  | {
      readonly type: "cascadeDiscontinue";
      /** §2.2 — fired by the `m6.admission.discharged` consumer (system actor). */
      readonly isSystemActor: boolean;
      readonly reason: OrderDiscontinuationReason;
    };

export type OrderTransition = OrderTransitionResult<OrderState, OrderEvent["type"]>;

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const ORDER_GRAPH: Readonly<Record<OrderState, ReadonlyArray<OrderEvent["type"]>>> = {
  draft: ["requestSignature", "discardDraft"],
  pending_signature: ["sign", "recordVerbal", "withdraw", "discontinue", "cascadeDiscontinue"],
  verbal_pending: ["sign", "expire", "discontinue", "cascadeDiscontinue"],
  active: ["complete", "discontinue", "cascadeDiscontinue"],
  completed: [],
  discontinued: [],
  expired_unsigned: [],
};

/**
 * The genesis of an order: a `draft` row (§2.2). There is no prior state, so this is a factory, not a
 * transition — the §2.1 authoring guard (`disciplineCanOrder`) is composed by the service before this
 * runs. Returns the §2.8 side-effect list the service executes inside the create transaction (audit +
 * the `m11.order.draft_created` outbox event).
 */
export function planDraftCreation(): ReadonlyArray<OrderSideEffect> {
  return [{ kind: "audit" }, { kind: "outbox", event: "m11.order.draft_created" }];
}

/** The always-emitted sign effects + the kind-specific downstream `m11.*` events (§4.4 routing). */
function signEffects(kind: OrderKind, extra: ReadonlyArray<OrderSideEffect>): ReadonlyArray<OrderSideEffect> {
  const downstream: ReadonlyArray<OrderSideEffect> = KIND_CATALOG[kind].downstreamSignedEvents.map(
    (event: M11EventName) => ({ kind: "outbox", event }) as const,
  );
  return [
    { kind: "write_signature", signature: "signature" },
    { kind: "set_timestamp", field: "signed_at" },
    { kind: "bump_version" },
    { kind: "audit" },
    { kind: "outbox", event: "m11.order.signed" },
    ...extra,
    ...downstream,
  ];
}

/**
 * Apply an order lifecycle event (§2.2). Throws {@link OrderStateError} `ILLEGAL_ORDER_TRANSITION` if the
 * event is not accepted from `from`, or the specific §2.2 guard code on a guard failure. Returns the new
 * state + the ordered §2.6/§2.8 side-effect list the service runs in the order's optimistic-locked tx.
 */
export function transitionOrder(from: OrderState, event: OrderEvent): OrderTransition {
  if (!ORDER_GRAPH[from].includes(event.type)) {
    throw new OrderStateError(
      "ILLEGAL_ORDER_TRANSITION",
      `order cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "requestSignature": {
      require_(
        event.requiredFieldsComplete,
        "ORDER_REQUIRED_FIELDS_INCOMPLETE",
        "the order's per-kind required fields are not complete",
      );
      const effects: OrderSideEffect[] = [
        {
          kind: "set_cosign_overlay",
          required: event.cosignRequired,
          status: event.cosignRequired ? "pending" : "attached",
        },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.signature_requested" },
      ];
      if (event.cosignRequired) {
        effects.push({ kind: "outbox", event: "m11.order.cosign_requested" });
      }
      return result(from, event.type, "pending_signature", effects);
    }

    case "discardDraft": {
      require_(event.actorMayDiscard, "DISCARD_NOT_PERMITTED", "only the drafter or a supervisor may discard a draft");
      require_(
        !event.hasExternalReferences,
        "ORDER_HAS_EXTERNAL_REFERENCES",
        "the draft is referenced by another order and cannot be discarded",
      );
      // A draft was never visible to chart consumers (§2.2): no downstream outbox event.
      return result(from, event.type, "discontinued", [{ kind: "audit" }]);
    }

    case "sign": {
      if (from === "pending_signature") {
        // §2.2 cosign overlay — the `sign` event is blocked until `cosign_status='attached'`.
        require_(event.cosignAttached, "COSIGN_PENDING", "this order requires a cosignature before it can be signed");
        const extra: OrderSideEffect[] = event.onBehalf
          ? [{ kind: "outbox", event: "m11.order.signed_on_behalf" }]
          : [];
        return result(from, event.type, "active", signEffects(event.kind, extra));
      }
      // from verbal_pending — the named practitioner signs in time (no on-behalf, §2.2); records timeliness.
      return result(from, event.type, "active", signEffects(event.kind, [
        { kind: "outbox", event: "m11.order.verbal_signed_in_time" },
      ]));
    }

    case "recordVerbal": {
      require_(
        KIND_CATALOG[event.kind].allowsVerbal,
        "VERBAL_NOT_ALLOWED_FOR_KIND",
        `'${event.kind}' requires a written, signed order ab initio and cannot be recorded as verbal (§2.3)`,
      );
      require_(event.recorderEligible, "VERBAL_RECORDER_NOT_ELIGIBLE", "the recording actor is not authorized to record verbal orders");
      require_(event.attestationRecorded, "VERBAL_ATTESTATION_REQUIRED", "a verbal-communication attestation is required");
      return result(from, event.type, "verbal_pending", [
        { kind: "write_verbal_order" },
        { kind: "write_signature", signature: "verbal_attestation" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.verbal_received" },
      ]);
    }

    case "withdraw": {
      require_(event.actorMayWithdraw, "WITHDRAW_NOT_PERMITTED", "only the drafter, supervisor, or signer may withdraw");
      return result(from, event.type, "discontinued", [
        { kind: "write_discontinuation", reason: "clinical_judgement" },
        { kind: "bump_version" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.discontinued" },
      ]);
    }

    case "expire": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "only the verbal-timer worker may expire a verbal order");
      require_(event.deadlineReached, "VERBAL_DEADLINE_NOT_REACHED", "the verbal-order signature deadline has not been reached");
      return result(from, event.type, "expired_unsigned", [
        { kind: "set_timestamp", field: "expired_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.verbal_expired_unsigned" },
      ]);
    }

    case "complete": {
      require_(event.criterionMet, "COMPLETION_CRITERION_NOT_MET", "the kind-specific completion criterion is not met");
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "completed_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.completed" },
      ]);
    }

    case "discontinue": {
      // §2.6 D13 — discontinuation is a command: an `order_discontinuation` row is written in the same tx.
      const effects: OrderSideEffect[] = [
        { kind: "write_discontinuation", reason: event.reason },
        { kind: "bump_version" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.discontinued" },
      ];
      const supplyKind = event.kind === "dme" || event.kind === "supply" || event.kind === "comfort_kit";
      if (supplyKind && event.fulfillmentInFlight) {
        effects.push({ kind: "outbox", event: "m11.order.supply_cancellation_requested" });
      }
      return result(from, event.type, "discontinued", effects);
    }

    case "cascadeDiscontinue": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the discharge-cascade is a system-actor operation");
      return result(from, event.type, "discontinued", [
        { kind: "write_discontinuation", reason: event.reason },
        { kind: "bump_version" },
        { kind: "audit" },
        { kind: "outbox", event: "m11.order.discontinued" },
      ]);
    }
  }
}
