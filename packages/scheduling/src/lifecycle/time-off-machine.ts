// @chartwarden/scheduling — §2.2.6 D7 time_off lifecycle state machine (M17-T03). Pure, IO-free.
//
// The §2.2.6 time_off machine:
//
//   requested ─approve→ approved ─consume→ consumed        (approve runs the reassignment-scan worker over
//      │                   └cancel→ cancelled               every published visit inside the PTO window)
//      └deny→ denied
//
// Same convention as the visit machine: validate the event against the §2.2.6 graph, run the enumerated
// guards (failures raise the precise §2.2.6 code via SchedulingStateError), and return the new state + the
// §2.4 in-transaction side-effect list. `time_off` carries no `visit_state_history` (that log is the
// visit's), but every transition still writes the M4 audit row and bumps the optimistic `version`.
import type { TimeOffState } from "@chartwarden/types";
import { type SchedulingSideEffect, type SchedulingTransitionResult, result } from "./effects";
import { SchedulingStateError, require_ } from "./errors";
import { TIME_OFF_DENIAL_REASON_MIN_LENGTH } from "./reason-floors";

export type TimeOffLifecycleState = TimeOffState;

/** The §2.2.6 time_off lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type TimeOffEvent =
  | {
      readonly type: "approve";
      /** §2.2.6 — `approved_by_membership_id` is required (the supervisor identity). */
      readonly approverPresent: boolean;
      /** §2.4 — how many published visits the reassignment scan will need to clear (drives the alert). */
      readonly conflictingVisitCount: number;
    }
  | {
      readonly type: "deny";
      /** §2.2.6 — `denial_reason ≥ 20 chars` (denylisted from audit per §3.6). */
      readonly reason: string;
    }
  | {
      readonly type: "cancel";
      /** §2.2.6 — the approved window has not yet started (cancel is pre-start only). */
      readonly windowStarted: boolean;
    }
  | {
      readonly type: "consume";
      /** §2.2.6 — fired by the system once the window has passed (clock guard). */
      readonly isSystemActor: boolean;
      readonly windowPassed: boolean;
    };

export type TimeOffTransition = SchedulingTransitionResult<
  TimeOffLifecycleState,
  TimeOffEvent["type"]
>;

/** The legal §2.2.6 transition graph (from → events accepted). Guards are checked separately. */
export const TIME_OFF_GRAPH: Readonly<
  Record<TimeOffLifecycleState, ReadonlyArray<TimeOffEvent["type"]>>
> = {
  requested: ["approve", "deny"],
  approved: ["cancel", "consume"],
  denied: [],
  cancelled: [],
  consumed: [],
};

/**
 * Apply a time_off lifecycle event (§2.2.6). Throws {@link SchedulingStateError}
 * `ILLEGAL_TIME_OFF_TRANSITION` if the event is not accepted from `from`, or the specific §2.2.6 guard
 * code on a guard failure. Returns the new state + the ordered §2.4 side-effect list.
 */
export function transitionTimeOff(
  from: TimeOffLifecycleState,
  event: TimeOffEvent,
): TimeOffTransition {
  if (!TIME_OFF_GRAPH[from].includes(event.type)) {
    throw new SchedulingStateError(
      "ILLEGAL_TIME_OFF_TRANSITION",
      `time_off cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "approve": {
      require_(
        event.approverPresent,
        "TIME_OFF_APPROVER_REQUIRED",
        "an approval requires `approved_by_membership_id`",
      );
      const effects: SchedulingSideEffect[] = [
        { kind: "set_timestamp", field: "approved_at" },
        { kind: "bump_version" },
        { kind: "audit" },
        // §2.4 — scan every published visit inside the window and emit `m17.reassignment_needed` per hit.
        { kind: "trigger_reassignment_scan" },
        { kind: "outbox", event: "m17.time_off.approved" },
        { kind: "alert", alert: "time_off_approved" },
      ];
      return result(from, event.type, "approved", effects);
    }

    case "deny": {
      require_(
        event.reason.trim().length >= TIME_OFF_DENIAL_REASON_MIN_LENGTH,
        "TIME_OFF_DENIAL_REASON_TOO_SHORT",
        `the denial reason must be at least ${TIME_OFF_DENIAL_REASON_MIN_LENGTH} characters`,
      );
      return result(from, event.type, "denied", [
        { kind: "capture_reason", field: "denial_reason", value: event.reason },
        { kind: "bump_version" },
        { kind: "audit" },
        { kind: "outbox", event: "m17.time_off.denied" },
        { kind: "alert", alert: "time_off_denied" },
      ]);
    }

    case "cancel": {
      require_(
        !event.windowStarted,
        "TIME_OFF_CANCEL_AFTER_START",
        "an approved time-off window can only be cancelled before it starts",
      );
      return result(from, event.type, "cancelled", [{ kind: "bump_version" }, { kind: "audit" }]);
    }

    case "consume": {
      require_(
        event.isSystemActor,
        "NOT_SYSTEM_ACTOR",
        "time-off is consumed by the system once the window passes",
      );
      require_(
        event.windowPassed,
        "TIME_OFF_WINDOW_NOT_PASSED",
        "the time-off window has not yet passed",
      );
      return result(from, event.type, "consumed", [{ kind: "bump_version" }, { kind: "audit" }]);
    }
  }
}

/**
 * The genesis of a time_off row: a `requested` row (§2.2.6). Returns the §2.4 effect list the service runs
 * in the create tx (audit + the `m17.time_off.requested` outbox event + the supervisor-approval alert).
 * `conflictingVisitCount` is the advisory count of published visits the window would overlap.
 */
export function planTimeOffRequested(): ReadonlyArray<SchedulingSideEffect> {
  return [
    { kind: "audit" },
    { kind: "outbox", event: "m17.time_off.requested" },
    { kind: "alert", alert: "time_off_requested" },
  ];
}
