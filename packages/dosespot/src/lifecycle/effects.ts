// @wardenx/dosespot — medication-order lifecycle side-effect descriptors (§2.2 / §2.6 D13, M12-T03).
//
// The M11 §2.8 pattern carried forward: every transition carries an explicit, in-transaction side-effect
// list (audit + outbox + child-row ops + the M11-seam invocations), and the COMMIT binds the
// `medication_order` row, the audit row, the child rows (transmission / discontinuation) and the outbox row
// atomically — the "DB updated but the event never went out" failure mode is eliminated structurally (M1
// §25.5/§25.6). This pure engine returns side effects DECLARATIVELY as data; the service layer (M12-T08)
// executes them inside the order's optimistic-locked transaction (load FOR UPDATE on version → run guards →
// update row → write child rows → call M11 `OrderSignatureProvider` → audit() → outbox.publish()). Keeping
// them as data makes the machines deterministic and unit-testable with no DB and no M11 runtime.
import type {
  DoseSpotSendState,
  EpcsSecondFactorType,
  M12AlertPayload,
  M12EventName,
  MedicationOrderDiscontinuationReason,
} from "@wardenx/types";

/** §4.9 — the discriminating `eventType` of a typed M36 alert M12 dispatches (no outbox wire name). */
export type M12AlertEventType = M12AlertPayload["eventType"];

/**
 * One in-transaction side effect a medication-order transition declares (§2.2 / §2.6). The service layer is
 * the only place these run; the machine never touches IO. `outbox` events are restricted to the §4.4
 * `m12.*` catalog. The two `*_via_m11` descriptors are the §2.8 D14 consumption of M11's
 * `OrderSignatureProvider` — the machine names the call; the service binds the registered seam at run time.
 */
export type MedicationOrderSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.8). */
  | { readonly kind: "audit" }
  /** Publish an `m12.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M12EventName }
  /** Dispatch a typed M36 alert that carries no outbox wire name (§4.9 — e.g. verbal-expiry). */
  | { readonly kind: "alert"; readonly alert: M12AlertEventType }
  /** §2.8 D14 — invoke M11 `OrderSignatureProvider.signOrderTarget({targetKind:'medication_order'})`. The
   * `secondFactorType` is populated only on the EPCS controlled-substance path (§2.4 §1311.116). */
  | {
      readonly kind: "sign_via_m11";
      readonly signatureKind: "signature";
      readonly secondFactorType?: EpcsSecondFactorType;
    }
  /** §2.3 D3 — invoke M11 `OrderSignatureProvider.recordVerbalOrder({targetKind:'medication_order'})`. */
  | { readonly kind: "record_verbal_via_m11" }
  /** §2.2 — insert the `medication_order_transmission` row at enqueue (the NewRx job's anchor row). */
  | { readonly kind: "write_transmission" }
  /** §2.2 — update the `medication_order_transmission` row on worker success / exhaustion. */
  | { readonly kind: "update_transmission"; readonly outcome: "succeeded" | "failed" }
  /** §2.2 — enqueue the `dosespot.transmit_newrx` BullMQ job (the adapter call lands M12-T06). */
  | { readonly kind: "enqueue_transmission_job" }
  /** §2.2 / §2.12 — write the `medication_order_discontinuation` row capturing actor + reason. */
  | { readonly kind: "write_discontinuation"; readonly reason: MedicationOrderDiscontinuationReason }
  /** §2.2 / §4.10 — set the orthogonal `dosespot_send_state` observed column. */
  | { readonly kind: "set_send_state"; readonly state: DoseSpotSendState }
  /** Set a timestamp/marker column on the aggregate (e.g. `signed_at`, `activated_at`, `discontinued_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** Increment the order row's optimistic-concurrency `version` (every signed-state mutation, §2.6). */
  | { readonly kind: "bump_version" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface MedicationOrderTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<MedicationOrderSideEffect>;
}

/** Build a {@link MedicationOrderTransitionResult} (keeps the machine terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<MedicationOrderSideEffect>,
): MedicationOrderTransitionResult<S, E> {
  return { from, event, to, effects };
}
