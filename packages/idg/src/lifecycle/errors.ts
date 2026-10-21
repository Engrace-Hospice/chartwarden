// @chartwarden/idg — M14 IDG-lifecycle failure-code catalog (§4.3, M14-T03).
//
// Every guard / validation failure in the pure IDG-lifecycle domain (the §2.2 meeting machine, the
// §2.7 decision recorder/emitter, the D8 action-item engine, the D10 minutes + amendment workflow)
// raises an `IdgStateError` carrying the machine-readable code below. The error extends the M1
// `ChartWardenError` envelope base (`@chartwarden/types` — NOT the banned `packages/foundation`) so the M1
// Fastify error handler renders it with the precise code + HTTP status with no cross-module import
// edge (the M8/M9/M11/M12/M13 lifecycle convention). Nothing transitions on a string match — each code
// is an enumerated constant; the M14-T05 routes/ABAC reuse these codes verbatim, and the §3.4 DB
// triggers (M14-T02) repeat the strongest (`MINUTES_FINAL`, `PACKET_FROZEN`) at the schema layer as
// defense in depth.
import { ChartWardenError } from "@chartwarden/types";

/** The §4.3 M14 IDG-lifecycle failure-code catalog → canonical HTTP status. */
export const M14_ERROR_STATUS = {
  // §2.2 — the meeting lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_MEETING_TRANSITION: 409,
  // §2.7 / §4.3 — a decision / action-item write attempted when the meeting is not `live`.
  MEETING_NOT_LIVE: 422,
  // §2.2 / §4.3 — `START` attempted on a meeting whose packets are not `packets_ready`.
  MEETING_NOT_PACKETS_READY: 422,
  // §2.7 / D3 / §4.3 — required IDG disciplines not present at decision write time (`quorate_decision`).
  QUORUM_NOT_MET: 422,
  // §2.2 / D13 / §4.3 — `ADJOURN` attempted without fresh step-up auth (≤ 5 min).
  STEP_UP_REQUIRED: 412,
  // §2.7 / §4.3 — a packet rebuild attempted after the meeting adjourned (`frozen_at` set).
  PACKET_FROZEN: 422,
  // §2.3 D9 / §4.3 — a decision recorded against a patient not on the meeting's caseload (URL-tamper).
  INCLUSION_CRITERIA_FAILED: 422,
  // D10 / §4.3 — a direct mutation of `final` minutes (the amendment workflow is required instead).
  MINUTES_FINAL: 422,
  // D10 — `finalizeMinutes` attempted on minutes not in `in_progress`.
  MINUTES_NOT_IN_PROGRESS: 409,
  // D10 — an amendment-approval applied to an already-approved `idg_minutes_amendment` row.
  AMENDMENT_ALREADY_APPROVED: 409,
  // §2.8 / §4.3 — a supersede / emit applied to a decision already superseded by another row.
  DECISION_SUPERSEDED: 409,
  // §2.7 — an emit / supersede applied to a decision not in `open`.
  DECISION_NOT_OPEN: 409,
  // D8 / §4.3 — a transition applied to an action item already closed by the auto-close engine.
  ACTION_ITEM_AUTO_CLOSED: 409,
  // D8 — the action-item lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_ACTION_ITEM_TRANSITION: 409,
  // §2.2 / M14-F01 / ADR-0018 D2 — CANCEL/RESCHEDULE would push an included patient past their
  // per-patient 15-day review floor with no covering meeting and no audited override.
  PER_PATIENT_REVIEW_FLOOR_BREACH: 422,
  // GAP-043 / §2.8 — a supersede whose successor meeting is not strictly later than the prior decision's meeting.
  SUPERSEDE_MEETING_NOT_SUBSEQUENT: 422,
  // §2.2 — CANCEL/RESCHEDULE attempted without a reason.
  MEETING_TRANSITION_REASON_REQUIRED: 422,
} as const;

/** A machine-readable M14 IDG-lifecycle failure code (§4.3). */
export type M14ErrorCode = keyof typeof M14_ERROR_STATUS;

/**
 * A guard / validation failure in the M14 IDG-lifecycle domain. Carries the precise `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class IdgStateError extends ChartWardenError {
  constructor(code: M14ErrorCode, message: string) {
    super(code, message, M14_ERROR_STATUS[code]);
    this.name = "IdgStateError";
  }
}

/** Throw an {@link IdgStateError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M14ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new IdgStateError(code, message);
}
