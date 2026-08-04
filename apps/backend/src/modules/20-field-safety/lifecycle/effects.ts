// apps/backend/src/modules/20-field-safety/lifecycle/effects.ts — M20-T03 (§2.4 side-effect table).
//
// §2.4's posture in one type: every M20 state change writes both the row mutation and its outbox row in the
// SAME transaction (the architecture §25.5 transactional outbox), so "the SOS escalated but nobody was
// paged" is eliminated structurally rather than by review. The machines in this directory return those side
// effects DECLARATIVELY as data; the M20-T06 route layer and the §4.8 workers execute them inside the
// aggregate's transaction. Keeping them as data is what makes the machines deterministic and unit-testable
// with no DB and no clock — the discipline M6/M7/M15/M16/M19/M21 each converged on.
//
// `outbox` is restricted to the §4.10 `m20.safety.*` catalog and `alert` to the §4.9 union, so a typo
// cannot invent a name the dispatcher (and `arch:gaps`) would not recognise.
//
// TIMESTAMP FIELDS ARE A CLOSED UNION, not `string` (the M21-T03 finding: a pure machine's effects
// type-check against nothing, so a `set_timestamp` naming a column that does not exist compiles clean,
// passes every gate, and silently no-ops at 3 a.m.). The union below lists exactly the mutable timestamp
// columns migration 0110 created on `safety_sos_alert` and `safety_check_in_schedule`.
//
// THE TERMINUS EFFECTS ARE THREE SEPARATE KINDS, not one. §2.2.2 makes `emergency_terminus` do four things
// SIMULTANEOUSLY — dial the consented emergency contact, surface M40's PSAP number to every recipient, page
// WardenX ops, and keep looping. Collapsing them into a single "terminus" effect would let a runner
// implement one and log a TODO for the others while the effect list still reads as satisfied; as three
// kinds, an unimplemented one is an unhandled case in the runner's switch.
import type {
  IsoInstant,
  M20EventName,
  MembershipId,
  SafetyAlertPayload,
  SafetyCheckInState,
  SafetyIncidentId,
  SafetySosCancelBiometricResult,
  SafetySosCancelStatus,
  SafetySosLifecycleState,
  SafetySosOutcome,
  VisitId,
} from "@wardenx/types";

/**
 * The timestamp columns a transition may stamp — exactly the ones migration 0110 created.
 *
 * `posted_at`, `expected_at` and `cancel_window_expired_at` are deliberately ABSENT: all three are written
 * once, at insert, by the recorder that mints the row, and a later transition that could re-stamp
 * `cancel_window_expired_at` would be able to reopen a closed cancel window (D5).
 */
export type SafetyTimestampField =
  | "cancel_attempted_at"
  | "acknowledged_at"
  | "resolved_at"
  | "overdue_detected_at"
  | "escalated_at";

/** One in-transaction side effect a transition declares (§2.4). */
export type SafetySideEffect =
  /** Write the M4 write-audit row for the aggregate (always present — see {@link withAudit}). */
  | { readonly kind: "audit" }
  /**
   * §2.2.2 — append the `safety_sos_alert_state_history` row for this transition. Separate from `audit`
   * because the two answer different questions: the M4 row is the tamper-evident who/when across every
   * table, while the history row is the ALERT's own ordered narrative and is what the §4.3 metrics seam
   * derives `minutesToAcknowledgment` from and what a deposition reads end to end.
   *
   * `systemActor` mirrors the §3.3 posture: a watchdog tier advance carries NO
   * `transitioned_by_membership_id`, because inventing one would make the ledger claim a supervisor acted
   * when nobody did.
   *
   * NOTE the §3.3 `m20_ssash_no_self` CHECK — `from_state <> to_state`. A transition that does not move the
   * state (the `emergency_terminus` re-page loop, a rejected cancel) MUST NOT emit this effect; see
   * `sos-escalator.ts` and `sos-alert.ts` for the two places that matters.
   */
  | {
      readonly kind: "sos_state_history";
      readonly from: SafetySosLifecycleState | null;
      readonly to: SafetySosLifecycleState;
      readonly systemActor: boolean;
    }
  /** Publish an `m20.safety.*` outbox event in the same tx (§4.10 catalog). */
  | { readonly kind: "outbox"; readonly event: M20EventName }
  /** Raise a §4.9 typed M36 alert. Only the DISCRIMINATOR is declared — the recipient set is resolved by
   *  the service layer through M36's `field_safety_composed` resolver (§4.5), which needs reads a pure
   *  machine cannot do. */
  | { readonly kind: "alert"; readonly alert: SafetyAlertPayload["eventType"] }
  /** Stamp one of the aggregate's timestamp columns. */
  | {
      readonly kind: "set_timestamp";
      readonly field: SafetyTimestampField;
      readonly at: IsoInstant;
    }
  /** D5 — write the cancel triple. §3.3's `m20_ssa_cancel_attempt` CHECK requires all three to move
   *  together, so they are ONE effect: a runner cannot write the status and forget the verdict. */
  | {
      readonly kind: "set_cancel_status";
      readonly status: SafetySosCancelStatus;
      readonly biometricResult: SafetySosCancelBiometricResult;
      readonly attemptedAt: IsoInstant;
    }
  /** §2.2.2 — the responder's outcome on `resolved`. */
  | { readonly kind: "set_sos_outcome"; readonly outcome: SafetySosOutcome }
  /** §3.3's `m20_ssa_ack_stamped` / `m20_ssa_resolved_stamped` — a state that names an actor carries one. */
  | {
      readonly kind: "set_actor";
      readonly field: "acknowledged_by_membership_id" | "resolved_by_membership_id";
      readonly membershipId: MembershipId;
    }
  /** §2.2.3 — link the incident the SOS was opened into (`m20_ssa_incident_linked`). */
  | { readonly kind: "link_incident"; readonly incidentId: SafetyIncidentId }
  /** §2.2.1 — move a `safety_check_in_schedule` row's state (the overdue detector's own write). */
  | { readonly kind: "set_schedule_state"; readonly state: SafetyCheckInState }
  /** §7.5 — ask M17 to cancel the in-progress visit. M20 never writes an M17 row; the outbox event is the
   *  request and M17's D3 handler decides. Carried as an effect rather than a bare outbox entry because the
   *  runner needs the visit id to build the §4.10 payload. */
  | { readonly kind: "request_visit_cancellation"; readonly visitId: VisitId }
  /**
   * §2.2.2 (a) — auto-dial the clinician's emergency contact at the terminus, where — and only where — an
   * active `emergency_contact_call` consent exists (D10). `consentPresent=false` is emitted too: the
   * terminus happened either way, and the §4.10 payload's `emergencyContactCallInitiated` has to be able to
   * say "we had nobody to call", which is itself the finding an agency needs after the fact.
   */
  | { readonly kind: "dial_emergency_contact"; readonly consentPresent: boolean }
  /** §2.2.2 (b) — surface M40's PSAP / 911 number for the last known location to EVERY recipient, so a
   *  human can call emergency services. The number itself never enters an outbox or audit payload (§8.8.2);
   *  the responder's client fetches it from M40 against the jurisdiction id. */
  | { readonly kind: "surface_psap_number" }
  /** §2.2.2 (c) / INT-031 — page WardenX ops through every available channel. */
  | { readonly kind: "page_wardenx_ops" };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface SafetyTransitionResult<S extends string, C extends string> {
  readonly from: S;
  readonly command: C;
  readonly to: S;
  readonly effects: ReadonlyArray<SafetySideEffect>;
}

/** Build a {@link SafetyTransitionResult} (keeps the machines terse and uniform). */
export function result<S extends string, C extends string>(
  from: S,
  command: C,
  to: S,
  effects: ReadonlyArray<SafetySideEffect>,
): SafetyTransitionResult<S, C> {
  return { from, command, to, effects };
}

/** The §2.4 invariant: every M20 mutation writes an M4 audit row. Every machine builds its effect list
 *  through this helper so "we forgot the audit row on the rare edge" cannot happen. */
export function withAudit(
  effects: ReadonlyArray<SafetySideEffect>,
): ReadonlyArray<SafetySideEffect> {
  return [{ kind: "audit" }, ...effects];
}

/** §2.2.2 — an SOS state transition additionally appends the history row. Ordered audit → history → the
 *  transition's own effects so a reader of the list sees the two invariants first. Callers that do NOT move
 *  the state use {@link withAudit} instead; the §3.3 `m20_ssash_no_self` CHECK refuses a history row whose
 *  from- and to-state are equal. */
export function withSosHistory(
  from: SafetySosLifecycleState | null,
  to: SafetySosLifecycleState,
  systemActor: boolean,
  effects: ReadonlyArray<SafetySideEffect>,
): ReadonlyArray<SafetySideEffect> {
  return [{ kind: "audit" }, { kind: "sos_state_history", from, to, systemActor }, ...effects];
}
