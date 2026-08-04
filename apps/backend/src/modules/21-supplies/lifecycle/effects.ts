// apps/backend/src/modules/21-supplies/lifecycle/effects.ts — M21-T03 (§2.11 side-effect rules).
//
// §2.11's whole posture in one type: every M21 mutation has a defined audit + outbox + alert result, and the
// COMMIT binds the domain row, the M4 audit row and the outbox row atomically — "the kit deployed but
// `deployed_at_patient` never went out" is eliminated structurally rather than by review. The machines here
// return those side effects DECLARATIVELY as data; the M21-T05 service layer (routes) and the §4.6 workers
// execute them inside the aggregate's transaction. Keeping them as data is what makes the machines
// deterministic and unit-testable with no DB — the same discipline M6/M7/M15/M16 fixed.
//
// `outbox` events are restricted to the §4.5.2 `m21.*` catalog and `alert` to the §4.7 union, so a typo
// cannot invent a name the dispatcher (and `arch:gaps`) would not recognise.
import type {
  ComfortKitDispatchStatus,
  ComfortKitDisposalMethod,
  IsoInstant,
  M21EventName,
  MembershipId,
  RoutingRuleResolved,
  SuppliesAlertPayload,
  SupplyCourierAttestation,
  SupplyReceivedConfirmedActor,
} from "@wardenx/types";

/** One in-transaction side effect a transition declares (§2.11). */
export type SupplySideEffect =
  /** Write the M4 write-audit row for the aggregate (always present). */
  | { readonly kind: "audit" }
  /** Publish an `m21.*` outbox event in the same tx (§4.5.2 catalog). */
  | { readonly kind: "outbox"; readonly event: M21EventName }
  /** Raise a §4.7 typed M36 alert. Only the DISCRIMINATOR is declared — the service layer resolves the
   *  recipient role and the rest of the payload, which needs reads the pure machine cannot do. */
  | { readonly kind: "alert"; readonly alert: SuppliesAlertPayload["alertKind"] }
  /** Set a timestamp column on the aggregate (`ordered_at`, `delivered_at`, `reconciled_at`, …). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: IsoInstant }
  /** D4 — freeze the routing resolution onto `routing_rule_resolved_jsonb`. Written ONCE, at
   *  `vendor_assigned`; every later transition reads it and none rewrites it. */
  | { readonly kind: "freeze_routing"; readonly resolved: RoutingRuleResolved }
  /** Record the vendor-side PO (Phase-1 manual entry, Phase-2 the EDI 855 payload). */
  | { readonly kind: "record_vendor_order"; readonly vendorOrderReference: string }
  /** Record the shipment identifiers (Phase-1 manual, Phase-2 the EDI 856 ASN). */
  | { readonly kind: "record_shipment"; readonly trackingNumber: string; readonly carrier: string }
  /** D7 — the courier attestation captured at `delivered`. */
  | { readonly kind: "record_courier_attestation"; readonly attestation: SupplyCourierAttestation }
  /** §2.2 — who said it arrived. `system_auto_confirm` is the 72h fallback and must render distinctly. */
  | {
      readonly kind: "record_received_confirmation";
      readonly actor: SupplyReceivedConfirmedActor;
      readonly at: IsoInstant;
    }
  /** §2.2 — the cancellation record. `requiredVendorConfirmation` distinguishes the immediate pre-`ordered`
   *  path from the two-phase one the vendor had to answer. */
  | {
      readonly kind: "record_cancellation";
      readonly reason: string;
      readonly requiredVendorConfirmation: boolean;
      readonly at: IsoInstant;
    }
  /** §2.5 — insert the `comfort_kit_dispatch` + its `comfort_kit_dispatched_content` lines in the SAME
   *  transaction as the `ordered` transition. A failure here rolls the transition back (§2.5). */
  | { readonly kind: "create_dispatch"; readonly lineCount: number }
  /** M21-F04 — move the dispatch row's own status (it outlives the request's terminal state). */
  | { readonly kind: "set_dispatch_status"; readonly status: ComfortKitDispatchStatus }
  /** §2.5 — M13's ack arrived; bind `comfort_kit_dispatch.m13_deployment_id`. */
  | { readonly kind: "link_m13_deployment"; readonly m13DeploymentId: string }
  /** §2.6 — open the return obligation (the M13 return-required cascade). */
  | { readonly kind: "create_return"; readonly returnDueAt: IsoInstant }
  /** §2.6 — point `assigned_retrieving_membership_id` at the supply-team member who will physically
   *  retrieve. There is no `assigned_at` column: the assignment IS the state change, and the M4 audit row
   *  carries when it happened. */
  | { readonly kind: "assign_retriever"; readonly membershipId: MembershipId }
  /** §2.6 — the 90-day disposition: reason + attestor, both required by the §3.1.10 CHECK. */
  | {
      readonly kind: "record_unreturnable";
      readonly reason: string;
      readonly attestedByMembershipId: MembershipId;
    }
  /** §2.6 — insert the per-line `comfort_kit_returned_content` accounting at reconciliation. */
  | {
      readonly kind: "insert_returned_contents";
      readonly lineCount: number;
      readonly flaggedLineCount: number;
    }
  /** §2.6 — the disposal record, frozen against the jurisdiction policy AS APPLIED: state law changes, this
   *  record must not. */
  | {
      readonly kind: "record_disposal";
      readonly disposalMethod: ComfortKitDisposalMethod;
      readonly witnessMembershipId: MembershipId | null;
      readonly jurisdictionPolicyDigest: string;
    }
  /** §2.7 — signed change to `par_stock.current_quantity` (decimal string; negative on a dispatch). */
  | { readonly kind: "adjust_par_stock"; readonly delta: string; readonly nextQuantity: string }
  /** §4.5.2 — ask M22 for the BOL / packing list or the DEA-1304-format return receipt. */
  | {
      readonly kind: "request_document";
      readonly documentKind: "bill_of_lading" | "return_receipt";
    };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface SupplyTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<SupplySideEffect>;
}

/** Build a {@link SupplyTransitionResult} (keeps the four machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<SupplySideEffect>,
): SupplyTransitionResult<S, E> {
  return { from, event, to, effects };
}

/** The §2.11 invariant: every M21 mutation writes an M4 audit row. Every machine builds its effect list
 *  through this helper so "we forgot the audit row on the rare edge" cannot happen. */
export function withAudit(
  effects: ReadonlyArray<SupplySideEffect>,
): ReadonlyArray<SupplySideEffect> {
  return [{ kind: "audit" }, ...effects];
}
