// @wardenx/scheduling — scheduling-lifecycle side-effect descriptors (§2.4 / §2.2.6, M17-T03).
//
// The M8/M11/M14 §2.8 pattern: every transition carries an explicit, in-transaction side-effect list
// (audit + outbox + the `visit_state_history` append + aggregate-column writes), and the COMMIT binds the
// aggregate row, the audit row, the `visit_state_history` row, and the outbox row atomically — the "DB
// updated but the event never went out" failure mode is eliminated structurally (M1 §25.5/§25.6). This pure
// engine returns side effects DECLARATIVELY as data; the service layer (M17-T07) executes them inside the
// visit's optimistic-locked transaction (load FOR UPDATE on `version` → run guards → update row → append
// `visit_state_history` → audit() → outbox.publish()). Keeping them as data makes the machines
// deterministic and unit-testable with no DB.
import type {
  EvvBracketState,
  M17EventName,
  SchedulingAlertPayload,
  VisitStatus,
} from "@wardenx/types";

/** The §4.9 typed-alert discriminator the `alert` effect names (the payload is assembled in M17-T08). */
export type SchedulingAlertKind = SchedulingAlertPayload["kind"];

/** The free-text reason columns a transition may capture (each denylisted from audit per §3.6). */
export type SchedulingReasonField =
  | "cancellation_reason"
  | "reschedule_reason"
  | "no_show_reason"
  | "evv_missing_reason"
  | "denial_reason"
  | "dismissal_reason";

/**
 * One in-transaction (or, for alerts, fire-and-forget) side effect a transition declares (§2.4). The
 * service layer is the only place these run; the machines never touch IO. `outbox` events are restricted to
 * the §4.11 `m17.*` catalog.
 */
export type SchedulingSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present per §2.8). */
  | { readonly kind: "audit" }
  /** Publish an `m17.*` outbox event in the same tx (§4.11 catalog). */
  | { readonly kind: "outbox"; readonly event: M17EventName }
  /** Dispatch a typed M36 alert (fire-and-forget, §4.9 — never rolls back the transition). */
  | { readonly kind: "alert"; readonly alert: SchedulingAlertKind }
  /** Append the §2.2.2 `visit_state_history` row for this transition (append-only; never updated/deleted).
   * `systemDriven` ⇒ `actor_membership_id` is NULL (EVV-event / encounter-signed / cron transitions). */
  | {
      readonly kind: "write_state_history";
      readonly from: VisitStatus;
      readonly to: VisitStatus;
      readonly reason: string | null;
      readonly systemDriven: boolean;
    }
  /** Stamp the §1.1 / D3 EVV-bracket flag on the visit row (`evv_present` | `evv_missing_documented`). */
  | { readonly kind: "set_evv_bracket"; readonly state: EvvBracketState }
  /** Persist a denylisted free-text reason on the aggregate (§3.6 audit scrub records `<changed>`). */
  | {
      readonly kind: "capture_reason";
      readonly field: SchedulingReasonField;
      readonly value: string;
    }
  /** Set a timestamp/marker column on the aggregate (e.g. `published_at`, `completed_at`, `approved_at`). */
  | { readonly kind: "set_timestamp"; readonly field: string }
  /** §2.2.1 `reschedule` — point the original row's `rescheduled_into_visit_id` at the new visit (id minted
   * by the service in the same tx). */
  | { readonly kind: "link_rescheduled_into" }
  /** §2.2.6 `time_off` approved — run the `reassignment-scan` worker over published visits in the window. */
  | { readonly kind: "trigger_reassignment_scan" }
  /** Increment the aggregate row's optimistic-concurrency `version` (every state mutation, §2.5). */
  | { readonly kind: "bump_version" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface SchedulingTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<SchedulingSideEffect>;
}

/** Build a {@link SchedulingTransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<SchedulingSideEffect>,
): SchedulingTransitionResult<S, E> {
  return { from, event, to, effects };
}

/** Collect the outbox event names a side-effect list declares, order-preserving (test/assembly helper). */
export function outboxEvents(effects: ReadonlyArray<SchedulingSideEffect>): M17EventName[] {
  return effects
    .filter((e): e is Extract<SchedulingSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}
