// apps/backend/src/modules/08-encounters/lifecycle/errors.ts — M8-T04 (§2.3, §2.7).
//
// Every guard / validation failure in the M8 encounter domain raises an `EncounterStateError` carrying
// the machine-readable code the spec's §2.7 table enumerates (e.g. `INVALID_ENCOUNTER_DISCIPLINE_PAIR`,
// `STEP_UP_AUTH_REQUIRED`, `IMMUTABLE_AFTER_SIGN`). The error extends the M1 `WardenXError` envelope
// base (packages/types — NOT the banned packages/foundation) so the M1 Fastify error handler renders it
// with the precise code + HTTP status the UI keys its message off, with no cross-module import edge. The
// code→status mapping is the single source mirrored from §2.7; nothing transitions on a string match —
// each code is an enumerated constant (the M6 state-machine convention).
import { WardenXError } from "@wardenx/types";

/** The full §2.7 + §2.3 machine-readable failure-code catalog → canonical HTTP status. */
export const M8_ERROR_STATUS = {
  // §2.7 service-guard rules (run before any DB write)
  INVALID_ENCOUNTER_DISCIPLINE_PAIR: 422,
  SERVICE_DATE_IN_FUTURE: 422,
  SERVICE_DATE_BEFORE_ADMISSION: 422,
  LATE_ENTRY_REASON_REQUIRED: 422,
  NO_VOLUNTEER_ASSIGNMENT: 422,
  VOCAB_VERSION_MISMATCH: 409,
  // §2.7 sign-service rules
  STEP_UP_AUTH_REQUIRED: 412,
  F2F_DUAL_WRITE_REQUIRED: 412,
  NOT_COSIGN_ELIGIBLE: 403,
  NO_ELIGIBLE_COSIGNER: 422,
  // §2.2 / §3.3 vitals + mileage authoring (T10 — mirrors the DB CHECK constraints)
  VITALS_OUT_OF_RANGE: 422,
  VITALS_CNI_REASON_REQUIRED: 422,
  MILEAGE_ODOMETER_ORDER: 422,
  MILEAGE_OVERRIDE_REASON_REQUIRED: 422,
  // §2.4 D3 cosignature-request lifecycle (T06)
  COSIGNATURE_LOCKED: 409,
  SUPERVISOR_RELEASE_NOT_PERMITTED: 403,
  SUPERVISOR_RELEASE_REASON_TOO_SHORT: 422,
  // §2.5 D4 late-entry tier overrides (T07)
  SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED: 422,
  ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED: 422,
  SIGNIFICANT_LATE_OVERRIDE_NOT_PERMITTED: 403,
  SIGNIFICANT_LATE_OVERRIDE_REASON_TOO_SHORT: 422,
  ADMINISTRATIVE_OVERRIDE_NOT_PERMITTED: 403,
  ADMINISTRATIVE_OVERRIDE_REASON_TOO_SHORT: 422,
  LATE_ENTRY_TIER_MISMATCH: 409,
  // §2.7 repository / immutability rules
  PARENT_VOIDED: 409,
  VERSION_MISMATCH: 412,
  IMMUTABLE_AFTER_SIGN: 409,
  // §2.3 Layer-3 gate (enforced at sign; preview at finalize)
  COMPLIANCE_GATE_FAILED: 422,
  // §2.3 void (admin-only; reason ≥ 40 chars)
  VOID_NOT_PERMITTED: 403,
  VOID_REASON_TOO_SHORT: 422,
  // Structural — an event dispatched from a state that does not accept it (§2.3 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M8 encounter-domain failure code (§2.7 / §2.3). */
export type M8ErrorCode = keyof typeof M8_ERROR_STATUS;

/**
 * A guard / validation failure in the M8 encounter domain. Carries the precise §2.7 `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.3 every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class EncounterStateError extends WardenXError {
  constructor(code: M8ErrorCode, message: string) {
    super(code, message, M8_ERROR_STATUS[code]);
    this.name = "EncounterStateError";
  }
}

/** Throw an {@link EncounterStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M8ErrorCode, message: string): void {
  if (!condition) throw new EncounterStateError(code, message);
}
