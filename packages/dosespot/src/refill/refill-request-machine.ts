// @wardenx/dosespot — §2.7 D9 refill-inbox workflow state machine (M12-T04). Pure, IO-free.
//
// The §2.7 refill-inbox lifecycle: a pharmacy-initiated refill arrives as a DoseSpot `RefillRequest` webhook
// → the typed handler writes a `refill_request` row (`status='pending'`) → the prescriber approves or denies
// from the `/refills` inbox. A refill is a *new prescription*, not a status flip on the source order (D9): on
// approve the service mints a NEW `medication_order` with `derived_from_refill_id` set and runs the standard
// sign workflow (the `lifecycle/` medication-order machine, with the EPCS layer for controlled substances) —
// keeping the audit trail clean and reusing the entire sign path. On deny the DoseSpot adapter is told, and
// the care team is notified. A pending request may also `expire` (system-actor: DoseSpot withdrawal or the
// source order being discontinued).
//
//   pending ─approve→ approved   (mints a new medication_order; DoseSpot told the new Rx id)
//     │     ─deny→    denied      (DoseSpot told the denial + reason; care-team notified)
//     └     ─expire→  expired     (system-actor; no new order)
//
// Pure transition function (the M11/M12 convention): it validates the event is legal from the current
// status, runs the §2.7 guards (failures raise the precise code via `RefillStateError`), and returns the new
// status + the in-transaction side-effect list. No IO; every fact a guard needs (actor scope, source-order
// active, schedule rules, denial reason present) is resolved upstream and passed in.
import type {
  DeaSchedule,
  RefillRequestId,
  RefillRequestStatus,
  RefillResponseChannel,
} from "@wardenx/types";
import { assertRefillAuthorizedCount } from "./controlled-substance-refill-rules";
import { type RefillSideEffect, type RefillTransitionResult, refillResult } from "./effects";
import { RefillStateError, requireRefill } from "./errors";

/** The §2.7 refill-inbox events. Per-event facts are resolved upstream and injected as data. */
export type RefillRequestEvent =
  | {
      readonly type: "approve";
      /** §4.7 `refill_inbox_scope` — the approving actor is within this refill's inbox scope. */
      readonly actorInScope: boolean;
      /** §2.7 — the source `medication_order` is still `active` (a refill renews an active prescription). */
      readonly sourceOrderActive: boolean;
      /** §1.4 — the source order's DEA schedule (`null` for a non-controlled medication). */
      readonly deaSchedule: DeaSchedule | null;
      /** §2.7 — the prescriber-authorized refill count on the minted order (schedule-checked here). */
      readonly refillsAuthorized: number;
      /** §2.7 — the per-tenant `controlled_substance_policy` max-refill override (tighten-only), if any. */
      readonly tenantMaxOverride?: number;
      /** §2.7 — the channel DoseSpot's refill response goes out on (default electronic). */
      readonly responseChannel: RefillResponseChannel;
    }
  | {
      readonly type: "deny";
      readonly actorInScope: boolean;
      /** §2.7 / §7.6 — a denial reason is recorded (denylisted free text on `denial_reason`). */
      readonly denialReasonPresent: boolean;
      readonly responseChannel: RefillResponseChannel;
    }
  | {
      readonly type: "expire";
      /** §2.7 — fired by the system (DoseSpot withdrawal / source discontinuation), never a human actor. */
      readonly isSystemActor: boolean;
    };

/** The legal §2.7 refill-inbox transition graph (from → events accepted). Guards are checked separately. */
export const REFILL_REQUEST_GRAPH: Readonly<
  Record<RefillRequestStatus, ReadonlyArray<RefillRequestEvent["type"]>>
> = {
  pending: ["approve", "deny", "expire"],
  approved: [],
  denied: [],
  expired: [],
};

/**
 * §2.7 — the genesis of a refill request: a `pending` row minted from a verified inbound DoseSpot
 * `RefillRequest` webhook. There is no prior status, so this is a factory, not a transition (the webhook
 * dedup + source-order resolution happen in the service before this runs). Returns the side-effect list the
 * service executes inside the receive transaction: the M4 audit row, the `m12.refill_request_received`
 * outbox event, and the `refill_request.received` typed M36 routine alert to the prescriber + care-team
 * channel (§2.7).
 */
export function planRefillReceipt(): ReadonlyArray<RefillSideEffect> {
  return [
    { kind: "audit" },
    { kind: "outbox", event: "m12.refill_request_received" },
    { kind: "alert", alert: "refill_request.received" },
  ];
}

/**
 * §2.7 — the approve-path mint descriptor: the facts the service hands to the medication-order machine's
 * draft+sign path to create the NEW prescription. `replacesMedicationOrderId` is always `null` — a refill is
 * a new prescription, not a replacement (D9 / W-MR-04). The schedule check has already passed in the
 * `approve` guard.
 */
export interface DerivedMedicationOrderMint {
  readonly derivedFromRefillId: RefillRequestId;
  readonly sourceMedicationOrderId: string;
  readonly replacesMedicationOrderId: null;
  readonly refillsAuthorized: number;
}

/** Build the §2.7 {@link DerivedMedicationOrderMint} for an approved refill (the service drives the sign). */
export function buildRefillMintFacts(
  refillRequestId: RefillRequestId,
  sourceMedicationOrderId: string,
  refillsAuthorized: number,
): DerivedMedicationOrderMint {
  return {
    derivedFromRefillId: refillRequestId,
    sourceMedicationOrderId,
    replacesMedicationOrderId: null,
    refillsAuthorized,
  };
}

/**
 * Apply a refill-inbox lifecycle event (§2.7 D9). Throws {@link RefillStateError}
 * `ILLEGAL_REFILL_TRANSITION` if the event is not accepted from `from`, or the specific §2.7 guard code on a
 * guard failure. Returns the new status + the ordered side-effect list the service runs in the refill row's
 * optimistic-locked tx (including the `mint_medication_order` descriptor on approve and the
 * `respond_to_dosespot` adapter call on approve/deny).
 */
export function transitionRefillRequest(
  from: RefillRequestStatus,
  refillRequestId: RefillRequestId,
  event: RefillRequestEvent,
): RefillTransitionResult {
  if (!REFILL_REQUEST_GRAPH[from].includes(event.type)) {
    throw new RefillStateError(
      "ILLEGAL_REFILL_TRANSITION",
      `refill request cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "approve": {
      requireRefill(
        event.actorInScope,
        "REFILL_ACTOR_NOT_IN_SCOPE",
        "the actor is not within this refill request's inbox scope",
      );
      requireRefill(
        event.sourceOrderActive,
        "REFILL_SOURCE_ORDER_NOT_ACTIVE",
        "the source medication order is not active; a refill renews only an active prescription",
      );
      // §1.4 — Schedule II non-refillable + schedule max-refill ceiling (tenant tighten-only).
      assertRefillAuthorizedCount(
        event.deaSchedule,
        event.refillsAuthorized,
        event.tenantMaxOverride,
      );
      return refillResult(from, event.type, "approved", [
        {
          kind: "mint_medication_order",
          derivedFromRefillId: refillRequestId,
          refillsAuthorized: event.refillsAuthorized,
        },
        { kind: "set_resulting_order" },
        { kind: "set_timestamp", field: "approved_at" },
        { kind: "audit" },
        { kind: "respond_to_dosespot", outcome: "approved", channel: event.responseChannel },
        { kind: "outbox", event: "m12.refill_request_approved" },
      ]);
    }

    case "deny": {
      requireRefill(
        event.actorInScope,
        "REFILL_ACTOR_NOT_IN_SCOPE",
        "the actor is not within this refill request's inbox scope",
      );
      requireRefill(
        event.denialReasonPresent,
        "REFILL_DENIAL_REASON_REQUIRED",
        "a denial reason is required to deny a refill request",
      );
      return refillResult(from, event.type, "denied", [
        { kind: "set_timestamp", field: "denied_at" },
        { kind: "audit" },
        { kind: "respond_to_dosespot", outcome: "denied", channel: event.responseChannel },
        { kind: "outbox", event: "m12.refill_request_denied" },
      ]);
    }

    case "expire": {
      requireRefill(
        event.isSystemActor,
        "REFILL_NOT_SYSTEM_ACTOR",
        "only the system may expire a pending refill request (DoseSpot withdrawal / source discontinuation)",
      );
      return refillResult(from, event.type, "expired", [
        { kind: "set_timestamp", field: "expired_at" },
        { kind: "audit" },
      ]);
    }
  }
}
