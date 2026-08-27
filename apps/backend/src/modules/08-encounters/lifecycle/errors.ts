// apps/backend/src/modules/08-encounters/lifecycle/errors.ts — M8-T04 (§2.3, §2.7).
//
// Every guard / validation failure in the M8 encounter domain raises an `EncounterStateError` carrying
// the machine-readable code the spec's §2.7 table enumerates (e.g. `INVALID_ENCOUNTER_DISCIPLINE_PAIR`,
// `STEP_UP_AUTH_REQUIRED`, `IMMUTABLE_AFTER_SIGN`). The error extends the M1 `WardenXError` envelope
// base (packages/types — NOT the banned packages/foundation) so the M1 Fastify error handler renders it
// with the precise code + HTTP status the UI keys its message off, with no cross-module import edge. The
// code→status mapping is the single source mirrored from §2.7; nothing transitions on a string match —
// each code is an enumerated constant (the M6 state-machine convention).
import { type ErrorDetailType, WardenXError } from "@wardenx/types";

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
  // §2.6 HearthNote Layer-1 assembly (#114). `@wardenx/hearthnote` documents its own error codes as
  // "mapped to HTTP by the M8 service in T09" — this is that mapping, which was never written because
  // nothing ever assembled. TEMPLATE_NOT_FOUND and VOCAB_VERSION_MISMATCH already have codes above
  // (INVALID_ENCOUNTER_DISCIPLINE_PAIR / VOCAB_VERSION_MISMATCH), exactly as the package prescribes.
  UNKNOWN_VOCAB_CODE: 422,
  UNKNOWN_TEMPLATE_SECTION: 422,
  /** No tenant-DEK envelope is bound, so §3.6 free text cannot be sealed — the write refuses. */
  HEARTHNOTE_CIPHER_UNBOUND: 503,
  // §2.3 Layer-3 gate (enforced at sign; preview at finalize)
  COMPLIANCE_GATE_FAILED: 422,
  /** A §2.6 check could not be DECIDED — an upstream reader the gate consults is unreachable. Distinct
   *  from COMPLIANCE_GATE_FAILED on purpose: 422 means the documentation is incomplete and the clinician
   *  can fix it, 503 means the gate did not run. Refusing is the only safe direction — a signing-blocking
   *  control that passes when it cannot evaluate is the defect this gate was fixed from (#121). */
  COMPLIANCE_GATE_UNAVAILABLE: 503,
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
  /** `details` carries the §2.6 Layer-3 remediation list on a gate failure (the only code that uses it
   *  today): `{ field?, code, message }` per failed check, rendered by the M1 error handler into the
   *  §4.3 envelope the UI already reads. Every other code raises without one. */
  constructor(code: M8ErrorCode, message: string, details?: ErrorDetailType[]) {
    super(code, message, M8_ERROR_STATUS[code], details);
    this.name = "EncounterStateError";
  }
}

/** Throw an {@link EncounterStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M8ErrorCode, message: string): void {
  if (!condition) throw new EncounterStateError(code, message);
}
