// apps/backend/src/modules/20-field-safety/lifecycle/errors.ts — M20-T03 (§2.2–§2.7, §7.3, §7.4, §7.8, §7.9).
//
// Every guard failure in the M20 field-safety domain raises a `SafetyStateError` carrying the
// machine-readable code the §7 workflow tables and the §4.2 route error blocks name. The error extends the
// M1 `WardenXError` envelope base (packages/types — NOT the banned packages/foundation) so the M1 Fastify
// error handler renders the exact code + status with no cross-module import edge. Mirrors the M19
// `TriageStateError` / M16 `BereavementStateError` precedent.
//
// CASING: bare SCREAMING_SNAKE. §2.2.2 and §2.5 each spell one code VERBATIM — `CANCEL_WINDOW_EXPIRED`
// (422) and `STALE_LIFECYCLE_STATE` (409) — and both are bare, so the whole catalog follows that dialect.
// Note the STATUS on the stale-write code: §2.5 says 409, not the 412 M19/M15 chose for their own
// optimistic-concurrency codes. The wire contract is the spec's, and a shared "platform 412" convention is
// not worth contradicting a spec that names its own status inline.
//
// FAIL DIRECTION IS PER GUARD and it is not uniform in this module, which is the whole point of M20-F05 /
// S13: a life-safety alert must never be refused for an administrative reason. So there is deliberately NO
// code here for "the clinician has not consented to coordinates" and none for "the device is not attested"
// — both are recorded FACTS on a delivered alert (M20-F16, §2.2.2), never refusals. The codes that DO exist
// refuse writes that would make the record lie: a cancel after the window, a resolve with no outcome, a
// location-stream sample the consent gates do not authorise.
import { WardenXError } from "@wardenx/types";

/** The §2.3 / §7 machine-readable failure-code catalog → HTTP status. */
export const M20_ERROR_STATUS = {
  // ── §2.2.2 SOS lifecycle ───────────────────────────────────────────────────────────────────────────
  /** An edge that does not exist for this (state, command) pair. §2.2.2's transition table is a WHITELIST:
   *  the ladder looks like a rank order and is not one — `acknowledge` is legal from FIVE different states
   *  and `escalate` only from four. */
  SOS_INVALID_STATE_TRANSITION: 409,
  /** `resolved` / `cancelled_in_window` / `incident_opened` — no command advances out of them (§2.2.2). */
  SOS_TERMINAL: 409,
  /** §2.5 VERBATIM, including the 409 — optimistic concurrency on `safety_sos_alert.version`. */
  STALE_LIFECYCLE_STATE: 409,
  /** §2.2.2 VERBATIM — the cancel route refuses any cancel after `cancel_window_expired_at`. D5's window
   *  is what makes the press deliberate; a cancel accepted a minute later is a suppression path. */
  CANCEL_WINDOW_EXPIRED: 422,
  /** D5 / §7.4 — only the clinician who raised the SOS may cancel it. The whole hostile-actor scenario is
   *  someone else holding the device, and a supervisor "cancelling" is an ACKNOWLEDGMENT, a different act
   *  with a different row. */
  CANCEL_NOT_BY_RAISER: 403,
  /** §2.2.2 — `resolving → resolved` with no `outcome`. The outcome is what the §4.3 metrics seam and the
   *  workers-comp file read; a resolved SOS that cannot say how it ended is not a record of anything. */
  SOS_OUTCOME_REQUIRED: 422,
  /** §2.2.2 — `resolving → resolved` with no resolution narrative. The schema leaves the cipher nullable
   *  (a row may be repaired); the WRITE PATH does not. */
  SOS_RESOLUTION_NARRATIVE_REQUIRED: 422,
  /** §3.3 `m20_ssa_incident_linked` — `incident_opened` without the incident it was opened into. */
  SOS_INCIDENT_LINK_REQUIRED: 422,
  /** §7.5 — an SOS resolved with `outcome='visit_cancelled'` but no visit to cancel. M20 never writes an
   *  M17 row; it emits `m20.safety.visit_cancellation_requested`, and that event needs a `visitId`. */
  SOS_VISIT_CONTEXT_REQUIRED: 422,

  // ── D6 / §7.9 / §8.7 the continuous-location stream ────────────────────────────────────────────────
  /** D6 — the tenant has not set `sosContinuousLocationEnabled`. The first of the two independent opt-ins;
   *  neither implies the other. */
  SOS_STREAM_POLICY_DISABLED: 403,
  /** D6 — this clinician has no ACTIVE `continuous_location_during_sos` consent. Fails closed on a
   *  missing, revoked or expired row alike: §8.7 has no exception, so "we could not read the consent" and
   *  "there is no consent" have to produce the same answer. */
  SOS_STREAM_CONSENT_MISSING: 403,
  /** D6 — the alert is not in a streaming state. Distinct from the migration-0111 BEFORE INSERT trigger,
   *  which enforces the wider `SAFETY_SOS_OPEN_STATES` floor: this is the app's narrower D6 window, and it
   *  exists so a sample is never written for a press that is still inside its cancel window. */
  SOS_STREAM_NOT_ACTIVE: 409,
  /** §8.7 forced sunset — `sosContinuousLocationMaxDurationHours` elapsed. There is no indefinite
   *  tracking and no extension route. */
  SOS_STREAM_MAX_DURATION_REACHED: 409,

  // ── D4 / §7.3 overdue check-in escalation ──────────────────────────────────────────────────────────
  /** §2.2.1 — the detector was handed a schedule in a state it does not act on (`recorded`,
   *  `superseded`, `incident_opened`). */
  OVERDUE_SCHEDULE_NOT_ACTIONABLE: 409,
  /** §2.2.1 / §3.3 `m20_scis_recorded_fulfilled` — a schedule reaches `recorded` only through the check-in
   *  that fulfilled it. */
  SCHEDULE_FULFILMENT_REQUIRED: 422,

  // ── §2.2.4 / D4 the policy resolver + editor ───────────────────────────────────────────────────────
  /** D4 — an edited value outside `SAFETY_POLICY_BOUNDS`. "Tighten-only" is a BAND per knob, not one
   *  comparison, because tighter runs in opposite directions per knob (§2.2.4). */
  POLICY_OUT_OF_BOUNDS: 422,
  /** §3.3 `m20_spv_overdue_ladder` — the four overdue thresholds are a ladder. A tenant that set
   *  `escalation < supervisor_alert` would page the medical director before the supervisor. */
  POLICY_LADDER_INVALID: 422,
  /** §2.2.4 / §3.3 — a policy edit is a compliance act and its reason is the only thing a later review
   *  reads to understand why the agency loosened its own watch. */
  POLICY_EDIT_REASON_REQUIRED: 422,
} as const;

/** A machine-readable M20 domain failure code (§2.3 / §7). */
export type M20ErrorCode = keyof typeof M20_ERROR_STATUS;

/**
 * A guard / validation failure in the M20 field-safety domain. Carries the precise code so the §5 screens
 * can render an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class SafetyStateError extends WardenXError {
  constructor(code: M20ErrorCode, message: string) {
    super(code, message, M20_ERROR_STATUS[code]);
    this.name = "SafetyStateError";
  }
}

/**
 * Throw a {@link SafetyStateError} when `condition` is false (guard helper).
 *
 * Declared `asserts condition` rather than returning `void`: a guard that proves a fact and then lets the
 * compiler forget it pushes every caller into a non-null assertion, and a `!` is exactly the shape that
 * survives a later refactor after the guard above it stopped guaranteeing anything.
 */
export function requireSafety(
  condition: boolean,
  code: M20ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SafetyStateError(code, message);
}
