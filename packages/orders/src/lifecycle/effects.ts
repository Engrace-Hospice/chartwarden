// @wardenx/orders — order-lifecycle side-effect descriptors (§2.2 / §2.6 D13, M11-T03).
//
// The M8/M6 §2.8 pattern: every transition carries an explicit, in-transaction side-effect list (audit +
// outbox + child-row ops), and the COMMIT binds the order row, the audit row, the child rows (signature /
// verbal_order / discontinuation) and the outbox row atomically — the "DB updated but the event never went
// out" failure mode is eliminated structurally (M1 §25.5/§25.6). This pure engine returns side effects
// DECLARATIVELY as data; the service layer (M11-T06+) executes them inside the order's optimistic-locked
// transaction (load FOR UPDATE on version → run guards → update row → write child rows → audit() →
// outbox.publish()). Keeping them as data makes the machines deterministic and unit-testable with no DB.
import type {
  M11EventName,
  OrderDiscontinuationReason,
  OrderSignatureKind,
  VerbalOrderStatus,
} from "@wardenx/types";

/**
 * One in-transaction side effect a transition declares (§2.2 / §2.6). The service layer is the only place
 * these run; the machine never touches IO. `outbox` events are restricted to the §4.4 `m11.*` catalog.
 */
export type OrderSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.8). */
  | { readonly kind: "audit" }
  /** Publish an `m11.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M11EventName }
  /** Write an `order_signature` row for the given polymorphic slot (signature / cosignature / verbal). */
  | { readonly kind: "write_signature"; readonly signature: OrderSignatureKind }
  /** Insert the `verbal_order` row holding `received_at` + `deadline_at` (§2.3 D3). */
  | { readonly kind: "write_verbal_order" }
  /** Write the `order_discontinuation` row capturing actor + reason + effective_at (§2.6 D13). */
  | { readonly kind: "write_discontinuation"; readonly reason: OrderDiscontinuationReason }
  /** Set the cosign overlay markers on the order row (`cosign_required` / `cosign_status`, §2.2). */
  | {
      readonly kind: "set_cosign_overlay";
      readonly required: boolean;
      readonly status: "pending" | "attached";
    }
  /** Flip the linked `verbal_order` row's own status (§2.3 — `signed_in_time` / `expired_unsigned`). */
  | { readonly kind: "set_verbal_status"; readonly status: VerbalOrderStatus }
  /** Set a timestamp/marker column on the aggregate (e.g. `signed_at`, `expired_at`, `completed_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** Increment the order row's optimistic-concurrency `version` (every signed-state mutation, §2.6). */
  | { readonly kind: "bump_version" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface OrderTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<OrderSideEffect>;
}

/** Build an {@link OrderTransitionResult} (keeps the machine terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<OrderSideEffect>,
): OrderTransitionResult<S, E> {
  return { from, event, to, effects };
}
