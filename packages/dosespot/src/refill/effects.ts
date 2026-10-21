// @chartwarden/dosespot — refill-inbox side-effect descriptors (§2.7 D9, M12-T04).
//
// The M12 medication-order-lifecycle pattern carried forward (`lifecycle/effects.ts`): every refill-inbox
// transition carries an explicit, in-transaction side-effect list (audit + outbox + the DoseSpot-adapter
// response + the new-order mint), and the COMMIT binds the `refill_request` row, the audit row, the minted
// `medication_order` (on approve) and the outbox row atomically — the "DB updated but the event never went
// out" failure mode is eliminated structurally (M1 §25.5/§25.6). This pure engine returns side effects
// DECLARATIVELY as data; the service layer (M12-T08) executes them inside the refill row's optimistic-locked
// transaction. Keeping them as data makes the workflow deterministic and unit-testable with no DB.
import type {
  M12AlertPayload,
  M12EventName,
  RefillRequestId,
  RefillRequestStatus,
  RefillResponseChannel,
} from "@chartwarden/types";

/** §4.9 — the discriminating `eventType` of a typed M36 alert M12 dispatches (no outbox wire name). Not
 * re-exported (the package root already surfaces it from `lifecycle/effects`); local to the refill effects. */
type M12AlertEventType = M12AlertPayload["eventType"];

/**
 * One in-transaction side effect a refill-inbox transition declares (§2.7). The service layer is the only
 * place these run; the workflow never touches IO. `outbox` events are restricted to the §4.4 `m12.*`
 * catalog. `mint_medication_order` names the §2.7 approve-path new-prescription mint the service drives
 * through the medication-order machine (`lifecycle/`); `respond_to_dosespot` names the
 * `DoseSpotClient.respondToRefillRequest` adapter call the service binds at run time (M12-T06).
 */
export type RefillSideEffect =
  /** Write the M4 write-audit row for the `refill_request` aggregate (always present per §2.7). */
  | { readonly kind: "audit" }
  /** Publish an `m12.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M12EventName }
  /** Dispatch a typed M36 alert that carries no outbox wire name (§4.9 — e.g. refill received / SLA). */
  | { readonly kind: "alert"; readonly alert: M12AlertEventType }
  /** Set a timestamp/marker column on the `refill_request` row (e.g. `approved_at`, `denied_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** §2.7 approve — mint a new `medication_order` with `derived_from_refill_id`; the service then drives the
   * standard sign workflow (EPCS layer for controlled). `refillsAuthorized` is the schedule-checked count. */
  | {
      readonly kind: "mint_medication_order";
      readonly derivedFromRefillId: RefillRequestId;
      readonly refillsAuthorized: number;
    }
  /** §2.7 approve — set `refill_request.resulting_medication_order_id` to the minted order once signed. */
  | { readonly kind: "set_resulting_order" }
  /** §2.7 — call `DoseSpotClient.respondToRefillRequest` with the approve/deny outcome over the channel. */
  | {
      readonly kind: "respond_to_dosespot";
      readonly outcome: "approved" | "denied";
      readonly channel: RefillResponseChannel;
    };

/** A refill-inbox transition's full result — the new status + its ordered side-effect list. */
export interface RefillTransitionResult {
  readonly from: RefillRequestStatus;
  readonly event: string;
  readonly to: RefillRequestStatus;
  readonly effects: ReadonlyArray<RefillSideEffect>;
}

/** Build a {@link RefillTransitionResult} (keeps the workflow terse and uniform). */
export function refillResult(
  from: RefillRequestStatus,
  event: string,
  to: RefillRequestStatus,
  effects: ReadonlyArray<RefillSideEffect>,
): RefillTransitionResult {
  return { from, event, to, effects };
}
