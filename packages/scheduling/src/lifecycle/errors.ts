// @wardenx/scheduling — M17 scheduling-lifecycle failure-code catalog (§2.2 / §2.3 / §7.7, M17-T03).
//
// Every guard / validation failure in the pure scheduling-lifecycle domain (the §2.2.1 visit machine, the
// §2.2.6 time_off machine, the §2.2.5 availability validator, the §7.7 RRULE materializer) raises a
// `SchedulingStateError` carrying the machine-readable code below. The error extends the M1 `WardenXError`
// envelope base (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler
// renders it with the precise code + HTTP status with no cross-module import edge (the M8/M11/M14 lifecycle
// convention). Nothing transitions on a string match — each code is an enumerated constant; the §2.3 / §2.5
// DB CHECK + GiST-exclusion backstops (`VISIT_OVERLAP_CONFLICT`, the reason-length CHECKs, M17-T02) repeat
// the strongest of these at the schema layer as defense in depth. The route layer (M17-T07) reuses these
// codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The M17 scheduling-lifecycle failure-code catalog → canonical HTTP status. */
export const M17_ERROR_STATUS = {
  // ── §2.2.1 visit lifecycle ──────────────────────────────────────────────────────────────────────
  // §2.2.1 — the visit transition graph (an event from a state that does not accept it).
  ILLEGAL_VISIT_TRANSITION: 409,
  // §2.2.1 `publish` — the D8 seven-predicate pre-schedule gate did not pass (the orchestrator names the
  // failing predicate at M17-T07; the machine refuses to leave `proposed` until the gate is satisfied).
  VISIT_PRE_SCHEDULE_GATE_UNMET: 422,
  // §2.2.1 `cancel` / §2.3 — `cancellation_reason` shorter than the 20-char floor.
  VISIT_CANCELLATION_REASON_TOO_SHORT: 422,
  // §2.2.1 `cancel` — `cancelled_by_membership_id` was not supplied.
  VISIT_CANCELLED_BY_REQUIRED: 422,
  // §2.2.1 `reschedule` / §2.3 — `reschedule_reason` shorter than the 20-char floor.
  VISIT_RESCHEDULE_REASON_TOO_SHORT: 422,
  // §2.2.1 / D3 self-attest start — `evv_missing_reason` shorter than the 40-char floor.
  EVV_MISSING_REASON_TOO_SHORT: 422,
  // §2.2.1 / D3 self-attest start — the M2 SESSION_POLICY step-up was not satisfied.
  EVV_SELF_ATTEST_STEP_UP_REQUIRED: 403,
  // §2.2.1 / §2.4 — an EVV-driven or `m8.encounter.signed`-driven transition reserved to the system was
  // attempted by a human actor (the self-attest path is the explicit human alternative).
  NOT_SYSTEM_ACTOR: 403,

  // ── §2.2.6 time_off lifecycle ───────────────────────────────────────────────────────────────────
  // §2.2.6 — the time_off transition graph (an event from a state that does not accept it).
  ILLEGAL_TIME_OFF_TRANSITION: 409,
  // §2.2.6 `approve` — `approved_by_membership_id` was not supplied.
  TIME_OFF_APPROVER_REQUIRED: 422,
  // §2.2.6 `deny` — `denial_reason` shorter than the 20-char floor.
  TIME_OFF_DENIAL_REASON_TOO_SHORT: 422,
  // §2.2.6 `cancel` — an approved window may only be cancelled before it starts.
  TIME_OFF_CANCEL_AFTER_START: 409,
  // §2.2.6 `consume` — the window has not yet passed (system-driven, clock guard).
  TIME_OFF_WINDOW_NOT_PASSED: 422,

  // ── §2.2.5 clinician_availability ─────────────────────────────────────────────────────────────────
  // §2.3 — `start_time >= end_time` (overnight shifts split into two rows).
  AVAILABILITY_WINDOW_INVALID: 422,

  // ── §2.2.3 / §7.7 recurring_visit (RRULE subset) ──────────────────────────────────────────────────
  // §2.3 / §7.7 — `FREQ ∉ {DAILY, WEEKLY}` (`MONTHLY` / `YEARLY` are deliberately excluded).
  RECURRENCE_FREQUENCY_NOT_SUPPORTED: 422,
  // §2.3 — the RRULE string is malformed or carries an operator outside the locked subset.
  RECURRENCE_INVALID_RRULE: 422,
  // §2.3 — both `COUNT` and `UNTIL` set (exactly one terminator).
  RECURRENCE_TERMINATOR_CONFLICT: 422,
  // §2.2.5 — a `FREQ=WEEKLY` rule with an empty or invalid `BYDAY` weekday set.
  RECURRENCE_BYDAY_INVALID: 422,
  // §2.2.3 `discontinue` — the policy is already discontinued.
  RECURRENCE_POLICY_NOT_ACTIVE: 409,

  // ── §2.2.4 / §7.7 D5 visit_proposal (frequency-driven proposal worker) ──────────────────────────────
  // §7.7 — the M7/M15 `frequency` string does not match the `count:unit:period` grammar.
  FREQUENCY_UNPARSEABLE: 422,
  // §2.2.4 — the proposal transition graph (an event from a state that does not accept it).
  ILLEGAL_PROPOSAL_TRANSITION: 409,
  // §2.2.4 `dismiss` — a dismissal must carry a reason (denylisted `dismissal_reason`).
  PROPOSAL_DISMISSAL_REASON_REQUIRED: 422,
} as const;

/** A machine-readable M17 scheduling-lifecycle failure code (§2.2 / §2.3 / §7.7). */
export type M17ErrorCode = keyof typeof M17_ERROR_STATUS;

/**
 * A guard / validation failure in the M17 scheduling-lifecycle domain. Carries the precise `code` so the
 * UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class SchedulingStateError extends WardenXError {
  constructor(code: M17ErrorCode, message: string) {
    super(code, message, M17_ERROR_STATUS[code]);
    this.name = "SchedulingStateError";
  }
}

/** Throw a {@link SchedulingStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M17ErrorCode, message: string): asserts condition {
  if (!condition) throw new SchedulingStateError(code, message);
}
