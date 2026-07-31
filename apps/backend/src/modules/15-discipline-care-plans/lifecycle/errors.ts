// apps/backend/src/modules/15-discipline-care-plans/lifecycle/errors.ts — M15-T03 (§2.2, §2.3).
//
// Every guard / validation failure in the M15 discipline-plan domain raises a `DisciplinePlanStateError`
// carrying the machine-readable code the §2.3 validation-rule table and the §4.2 route error blocks name
// (`INSUFFICIENT_SIGNERS`, `INVALID_ENCOUNTER_REFERENCE`, `CORRECTIVE_ACTIONS_REQUIRED`, …). The error
// extends the M1 `WardenXError` envelope base (packages/types — NOT the banned packages/foundation) so the
// M1 Fastify error handler renders the exact code + status the UI keys its message off, with no
// cross-module import edge. Mirrors the M7 `CarePlanStateError` precedent verbatim (§2.2.2 is M7 D1).
import { WardenXError } from "@wardenx/types";

/** The §2.3 / §4.2 machine-readable failure-code catalog → HTTP status. */
export const M15_ERROR_STATUS = {
  // Plan root + version lifecycle (§2.2.1 / §2.2.2)
  ONE_ACTIVE_PLAN_PER_ADMISSION_KIND: 409,
  PLAN_NOT_ACTIVE: 409,
  PLAN_DISCHARGED: 409,
  SNAPSHOT_SEALED: 409,
  // Per-kind finalize readiness (§2.3)
  AIDE_ASSIGNMENT_REQUIRED: 422,
  SUPERVISING_RN_REQUIRED: 422,
  VOLUNTEER_ASSIGNMENT_REQUIRED: 422,
  VOLUNTEER_OUT_OF_SCOPE_UNACKNOWLEDGED: 422,
  // Required-signer quorum (§2.3 / §3.5 D11)
  INSUFFICIENT_SIGNERS: 412,
  SIGNER_ROLE_MISMATCH: 403,
  DUPLICATE_SIGNER_ROLE: 409,
  // Element authoring invariants (§2.2.3 / §2.3)
  GOAL_TEXT_IMMUTABLE: 422,
  DPOA_CONSENT_REQUIRED: 422,
  PARENT_PROBLEM_REQUIRED: 422,
  PARENT_ELEMENT_NOT_FOUND: 422,
  DISCIPLINE_SCOPE_VIOLATION: 403,
  DISCONTINUE_REASON_REQUIRED: 422,
  INTERVENTION_FREQUENCY_REQUIRED: 422,
  // Assessments (§2.2.3 / §7.2 / §7.3)
  AMENDMENT_REASON_REQUIRED: 422,
  AMENDMENT_TARGET_NOT_SIGNED: 409,
  INVALID_ENCOUNTER_REFERENCE: 422,
  SPIRITUAL_DECLINATION_IMMUTABLE: 409,
  // Aide supervisory visits (§2.2.4 / §7.1 / §4.2)
  CORRECTIVE_ACTIONS_REQUIRED: 422,
  AIDE_NOT_ON_PLAN: 422,
  NOT_AIDE_SUPERVISOR: 403,
  SUPERVISORY_CADENCE_ILLEGAL: 422,
  AIDE_SUPERVISORY_OVERDUE: 409,
  // Optimistic concurrency (§2.5 / §7.10)
  STALE_VERSION: 412,
  // Structural — an event dispatched from a state that does not accept it (§2.2 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M15 domain failure code (§2.3 / §4.2). */
export type M15ErrorCode = keyof typeof M15_ERROR_STATUS;

/**
 * A guard / validation failure in the M15 discipline-plan domain. Carries the precise §2.3 `code` so the
 * UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class DisciplinePlanStateError extends WardenXError {
  constructor(code: M15ErrorCode, message: string) {
    super(code, message, M15_ERROR_STATUS[code]);
    this.name = "DisciplinePlanStateError";
  }
}

/** Throw a {@link DisciplinePlanStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M15ErrorCode, message: string): void {
  if (!condition) throw new DisciplinePlanStateError(code, message);
}
