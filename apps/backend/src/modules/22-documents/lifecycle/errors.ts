// apps/backend/src/modules/22-documents/lifecycle/errors.ts — M22-T03 (§2.2 / §2.3).
//
// Every guard / validation failure in the M22 document-lifecycle domain raises a `DocumentStateError`
// carrying the machine-readable code the spec's §2.2 / §2.3 rules enumerate (e.g.
// `RETENTION_DOWNGRADE_FORBIDDEN`, `LEGAL_HOLD_BLOCKS_DESTRUCTION`, `VERSION_NUMBER_NOT_MONOTONIC`). The
// error extends the M1 `ChartWardenError` envelope base (packages/types — NOT the banned packages/foundation)
// so the M1 Fastify error handler renders it with the precise code + HTTP status, with no cross-module
// import edge. The code→status mapping is the single source mirrored from §2.2/§2.3; nothing transitions
// on a string match — each code is an enumerated constant (the M6 / M8 state-machine convention).
import { ChartWardenError } from "@wardenx/types";

/** The full §2.2 / §2.3 machine-readable failure-code catalog → canonical HTTP status. */
export const M22_LIFECYCLE_ERROR_STATUS = {
  // §2.3 versioning rules (D2)
  VERSION_NUMBER_NOT_MONOTONIC: 422,
  ACTIVE_VERSION_FOREIGN: 422,
  SHA256_IMMUTABLE: 409,
  // §2.3 retention-class consistency (D9 / D23)
  RETENTION_DOWNGRADE_FORBIDDEN: 422,
  RETENTION_IMMUTABLE: 409,
  PART2_RETENTION_IMMUTABLE: 409,
  // §2.3 patient-binding stability (patient.merged cascade only)
  PATIENT_BINDING_IMMUTABLE: 422,
  // §2.2.1 / §2.4 legal-hold place/release machine (from M4 events)
  LEGAL_HOLD_ALREADY_ACTIVE: 409,
  LEGAL_HOLD_NOT_ACTIVE: 409,
  // §2.2.1 / §11 D12 destruction + legal-hold skip
  LEGAL_HOLD_BLOCKS_DESTRUCTION: 409,
  ALREADY_TOMBSTONED: 409,
  // Structural — an event dispatched from a state that does not accept it (§2.2.1 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** A machine-readable M22 document-lifecycle failure code (§2.2 / §2.3). */
export type M22LifecycleErrorCode = keyof typeof M22_LIFECYCLE_ERROR_STATUS;

/**
 * A guard / validation failure in the M22 document-lifecycle domain. Carries the precise §2.2/§2.3 `code`
 * so the UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per the
 * M6/M8 convention every guard failure surfaces as one of these — never a raw PG exception or a generic
 * `ConflictError`.
 */
export class DocumentStateError extends ChartWardenError {
  constructor(code: M22LifecycleErrorCode, message: string) {
    super(code, message, M22_LIFECYCLE_ERROR_STATUS[code]);
    this.name = "DocumentStateError";
  }
}

/** Throw a {@link DocumentStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M22LifecycleErrorCode, message: string): void {
  if (!condition) throw new DocumentStateError(code, message);
}
