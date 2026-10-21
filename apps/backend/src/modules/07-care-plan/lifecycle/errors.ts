// apps/backend/src/modules/07-care-plan/lifecycle/errors.ts — M7-T03 (§2.2, §2.3).
//
// Every guard / validation failure in the M7 care-plan domain raises a `CarePlanStateError` carrying
// the machine-readable code that maps to the §2.3 validation-rule table (e.g. `REQUIRED_SIGNER_SET_UNMET`,
// `PATIENT_STATED_GOAL_VERBATIM`). The error extends the M1 `ChartWardenError` envelope base (packages/types
// — NOT the banned packages/foundation) so the M1 Fastify error handler renders it with the precise
// code + HTTP status the UI keys its message off, with no cross-module import edge. The code→status
// mapping is the single source mirrored from §2.3; nothing transitions on a string match — each code is
// an enumerated constant (mirrors the M6 `AdmissionStateError` precedent).
import { ChartWardenError } from "@wardenx/types";

/** The full §2.3 validation-rule + §2.2 lifecycle machine-readable failure-code catalog → HTTP status. */
export const M7_ERROR_STATUS = {
  // Care-plan root + version lifecycle (§2.2.1 / §2.2.2)
  ONE_ACTIVE_PLAN_PER_ADMISSION: 409,
  OPEN_VERSION_EXISTS: 409,
  CARE_PLAN_CLOSED: 409,
  CARE_PLAN_NOT_READY: 422,
  IDG_PROPOSAL_REQUIRED: 422,
  IDG_PROPOSAL_INVALID: 422,
  IDG_PROPOSAL_CONFLICT: 409,
  INITIAL_VERSION_REQUIRES_PROBLEM: 422,
  TERMINAL_PROBLEM_REQUIRED: 422,
  // Required-signer quorum (§2.3 / D5)
  REQUIRED_SIGNER_SET_UNMET: 409,
  SIGNER_ROLE_MISMATCH: 403,
  DUPLICATE_SIGNER_ROLE: 409,
  SIGNER_ALREADY_SIGNED: 409,
  // Element authoring invariants (§2.3)
  GOAL_REQUIRES_PROBLEM: 422,
  INTERVENTION_REQUIRES_PROBLEM: 422,
  INTERVENTION_FREQUENCY_REQUIRED: 422,
  PATIENT_STATED_GOAL_VERBATIM: 422,
  DPOA_CONSENT_REQUIRED: 422,
  // Discipline contribution (§7.4) — an actor authored an intervention outside their discipline.
  DISCIPLINE_SCOPE_VIOLATION: 403,
  // Element terminal-state capture gates (§2.2.3)
  RESOLUTION_NOTE_REQUIRED: 422,
  DISCONTINUE_REASON_REQUIRED: 422,
  // Optimistic concurrency (§2.3 / §7.7)
  STALE_VERSION: 412,
  // Structural — an event dispatched from a state that does not accept it (§2.2 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M7 domain failure code (§2.3 / §2.2). */
export type M7ErrorCode = keyof typeof M7_ERROR_STATUS;

/**
 * A guard / validation failure in the M7 care-plan domain. Carries the precise §2.3 `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class CarePlanStateError extends ChartWardenError {
  constructor(
    code: M7ErrorCode,
    message: string,
    details?: ConstructorParameters<typeof ChartWardenError>[3],
  ) {
    super(code, message, M7_ERROR_STATUS[code], details);
    this.name = "CarePlanStateError";
  }
}

/** Throw a {@link CarePlanStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M7ErrorCode, message: string): void {
  if (!condition) throw new CarePlanStateError(code, message);
}
