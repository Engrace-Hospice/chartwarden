// @wardenx/idg — §1.1 / D8 IDG action-item lifecycle + carry-forward + auto-close (M14-T03). Pure.
//
// The action-item aggregate lifecycle (§1.1 / D8):
//
//   open ─start→ in_progress ─complete→ completed
//    │  └complete / cancel / autoClose ┐  └cancel→ cancelled
//    ├cancel→ cancelled                └autoClose→ auto_closed
//    └autoClose→ auto_closed   (carry-forward is a NON-state-change overdue projection, §2.7 D8)
//
// `autoClose` is the D8 engine: when a downstream artifact reaches an absorbing state (M7 version_signed,
// M11 order signed/completed, M8 encounter signed matching assignee, M12 med-order signed/active), the
// linked action item flips to `auto_closed`. The §4.5 consumers (M14-T06) drive it; this is the pure
// decider. Carry-forward (D8) is the T-24h overdue projection of still-open items onto the next meeting's
// agenda — it does NOT change the action-item status, so it is a standalone planner.
import type { IdgActionItemLinkedKind, IdgActionItemStatus } from "@wardenx/types";
import { type IdgSideEffect, type IdgTransitionResult, result } from "./effects";
import { IdgStateError, require_ } from "./errors";

export type ActionItemState = IdgActionItemStatus;

/** The §1.1 / D8 action-item lifecycle events. Per-event facts are resolved upstream and injected. */
export type ActionItemEvent =
  | { readonly type: "start" }
  | { readonly type: "complete" }
  | { readonly type: "cancel" }
  | {
      readonly type: "autoClose";
      /** D8 — which absorbing downstream artifact closed the item (drives the close-trigger payload). */
      readonly linkedKind: IdgActionItemLinkedKind;
      /** D8 — the downstream artifact id confirmed onto `linked_artifact_id`. */
      readonly linkedArtifactId: string;
      /** §4.5 — auto-close is a system-actor (outbox-consumer) operation. */
      readonly isSystemActor: boolean;
    };

export type ActionItemTransition = IdgTransitionResult<ActionItemState, ActionItemEvent["type"]>;

/** The legal §1.1 / D8 action-item transition graph (from → events accepted). Guards checked separately. */
export const ACTION_ITEM_GRAPH: Readonly<
  Record<ActionItemState, ReadonlyArray<ActionItemEvent["type"]>>
> = {
  open: ["start", "complete", "cancel", "autoClose"],
  in_progress: ["complete", "cancel", "autoClose"],
  completed: [],
  cancelled: [],
  auto_closed: [],
};

/**
 * The genesis of an action item: an `open` row created from a decision or by a coordinator-direct add
 * (§2.7). Factory, not a transition. Returns the §2.8 side-effect list (audit + the
 * `m14.action_item.created` outbox + the M36 DM-to-assignee alert).
 */
export function planActionItemCreate(): ReadonlyArray<IdgSideEffect> {
  return [
    { kind: "audit" },
    { kind: "outbox", event: "m14.action_item.created" },
    { kind: "alert", alert: "m14.action_item.created" },
  ];
}

/**
 * Apply an action-item lifecycle event (§1.1 / D8). Throws {@link IdgStateError}
 * `ILLEGAL_ACTION_ITEM_TRANSITION` if the event is not accepted from `from` (a closed item — `completed` /
 * `cancelled` / `auto_closed` — accepts nothing; an `autoClose` retry on an `auto_closed` item raises the
 * specific `ACTION_ITEM_AUTO_CLOSED` code per §4.3), or the precise guard code on a guard failure. Returns
 * the new state + the §2.7 side-effect list.
 */
export function transitionActionItem(
  from: ActionItemState,
  event: ActionItemEvent,
): ActionItemTransition {
  if (from === "auto_closed" && event.type === "autoClose") {
    throw new IdgStateError(
      "ACTION_ITEM_AUTO_CLOSED",
      "this action item is already closed by the auto-close engine",
    );
  }
  if (!ACTION_ITEM_GRAPH[from].includes(event.type)) {
    throw new IdgStateError(
      "ILLEGAL_ACTION_ITEM_TRANSITION",
      `action item cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "start":
      return result(from, event.type, "in_progress", [
        { kind: "audit" },
        { kind: "outbox", event: "m14.action_item.status_changed" },
      ]);

    case "complete":
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "completed_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m14.action_item.status_changed" },
      ]);

    case "cancel":
      return result(from, event.type, "cancelled", [
        { kind: "set_timestamp", field: "cancelled_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m14.action_item.status_changed" },
      ]);

    case "autoClose":
      // §4.5 — the absorbing downstream artifact closes the item; informational confirmation to assignee.
      require_(
        event.isSystemActor,
        "ILLEGAL_ACTION_ITEM_TRANSITION",
        "auto-close is a system-actor operation",
      );
      return result(from, event.type, "auto_closed", [
        { kind: "confirm_linked_artifact" },
        { kind: "set_timestamp", field: "closed_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m14.action_item.auto_closed" },
      ]);
  }
}

/** The result of the §2.7 D8 carry-forward projection of an overdue open action item onto the next meeting. */
export interface CarryForwardResult {
  readonly newCarryForwardCount: number;
  readonly isComplianceAlert: boolean;
  readonly effects: ReadonlyArray<IdgSideEffect>;
}

/**
 * Plan the §2.7 D8 carry-forward of a still-open, overdue action item onto the next meeting (the T-24h cron
 * of the next meeting build). A new `idg_agenda_item` of `kind='carry_forward'` is created with
 * `carried_from_action_item_id`; the item's `carry_forward_count` increments. When the resulting count
 * reaches the §2.7 threshold (≥ 3) a critical-severity Compliance alert is emitted. The action item's own
 * status is unchanged — carry-forward surfaces it for discussion, it does not close or reopen it.
 *
 * `priorCarryForwardCount` is the item's current count; `isOpenAndOverdue` gates the projection (only an
 * `open`/`in_progress` item past its `due_date` carries forward — resolved upstream from the row + clock).
 */
export const CARRY_FORWARD_COMPLIANCE_THRESHOLD = 3 as const;

export function planCarryForward(input: {
  readonly priorCarryForwardCount: number;
  readonly isOpenAndOverdue: boolean;
}): CarryForwardResult {
  require_(
    input.isOpenAndOverdue,
    "ILLEGAL_ACTION_ITEM_TRANSITION",
    "only an open, overdue action item may be carried forward",
  );
  const newCarryForwardCount = input.priorCarryForwardCount + 1;
  const isComplianceAlert = newCarryForwardCount >= CARRY_FORWARD_COMPLIANCE_THRESHOLD;
  const effects: IdgSideEffect[] = [
    { kind: "audit" },
    { kind: "outbox", event: "m14.action_item.carry_forward" },
  ];
  if (isComplianceAlert)
    effects.push({ kind: "alert", alert: "m14.action_item.carry_forward.compliance" });
  return { newCarryForwardCount, isComplianceAlert, effects };
}
