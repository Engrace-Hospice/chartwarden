// @wardenx/hope — M10 domain failure-code catalog (§4.4, M10-T03).
//
// Every guard / validation failure in the M10 HOPE domain raises a `HopeStateError` carrying the
// machine-readable code the spec's §4.4 table enumerates (e.g. `M10_TIMEPOINT_EXPIRED`,
// `M10_DISCIPLINE_NOT_PERMITTED`, `M10_SFV_PAST_DUE`). The error extends the M1 `WardenXError` envelope
// base (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders
// it with the precise code + HTTP status with no cross-module import edge. The code→status mapping is the
// single source mirrored from §4.4; nothing transitions on a string match — each code is an enumerated
// constant (the M8/M9 lifecycle convention). The route layer (M10-T06) reuses these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The §4.4 M10-specific failure-code catalog → canonical HTTP status (full table; the timepoint /
 * discipline / SFV codes are raised by the M10-T03 pure machines, the remainder by later tasks' routes,
 * submission, and correction services). */
export const M10_ERROR_STATUS = {
  // §4.4 — timepoint capture window (D2): the soft-window + hard-cutoff enforcement.
  M10_TIMEPOINT_NOT_OPEN: 409,
  M10_TIMEPOINT_EXPIRED: 409,
  M10_LATE_REASON_REQUIRED: 400,
  M10_LATE_REASON_INVALID: 400,
  // §4.4 — recording preconditions.
  M10_ADMISSION_NOT_ACTIVE: 409,
  // #45 — the M6 status seam could not tell M10 WHOSE admission this is (the row is missing a fact the
  // seam projects non-null, the admission is another tenant's, or the seam is absent/denying). Not a
  // §4.4 code: it describes the state of the ADMISSION record, not of the capture. 422 — the request is
  // well-formed and no retry fixes it, but the admission can be repaired. It exists because the subject
  // of a HOPE record may never be guessed: `hope_assessment.patient_id` carries no FK (schema:
  // "M5 patient (app-validated; no cross-module FK)"), so a wrong id is accepted silently by Postgres
  // and surfaces later as a 404 on the sign path. Mirrors M9's `ADMISSION_PROJECTION_GAP` (#44).
  M10_ADMISSION_PROJECTION_GAP: 422,
  M10_DISCIPLINE_NOT_PERMITTED: 403,
  M10_RFA_KIND_MISMATCH: 409,
  M10_REQUIRED_SECTION_MISSING: 400,
  M10_FORBIDDEN_SECTION_PRESENT: 400,
  M10_DIAGNOSIS_NOT_IN_VALUE_SET: 400,
  // §4.4 — Symptom-Follow-Up-Visit lifecycle (D3/D4).
  M10_SFV_NO_TRIGGER: 409,
  M10_SFV_ALREADY_COMPLETED: 409,
  M10_SFV_PAST_DUE: 409,
  M10_SFV_WITHDRAWN: 409,
  // §4.4 — canonical answer engine / draft mutation.
  M10_ASSESSMENT_IMMUTABLE: 409,
  M10_VERSION_CONFLICT: 409,
  M10_DUPLICATE_ANSWER: 400,
  M10_PROTECTED_ANSWER: 403,
  M10_INVALID_ANSWER: 400,
  // §4.4 — correction-chain integrity (D7; the append-only correction RFA path, M10 later tasks).
  M10_CORRECTION_TARGET_NOT_SIGNED: 409,
  M10_CORRECTION_TARGET_SUPERSEDED: 409,
  // §4.4 — submission (D5; assembled/reconciled by the iQIES workers, M10-T07).
  M10_SUBMISSION_VALIDATION_FAILED: 422,
  M10_SUBMISSION_RETRY_NOT_REJECTED: 409,
  M10_IQIES_ADAPTER_UNAVAILABLE: 503,
} as const;

/** A machine-readable M10 HOPE-domain failure code (§4.4). */
export type M10ErrorCode = keyof typeof M10_ERROR_STATUS;

/**
 * A guard / validation failure in the M10 HOPE domain. Carries the precise §4.4 `code` so the UI renders
 * an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard failure
 * surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class HopeStateError extends WardenXError {
  constructor(code: M10ErrorCode, message: string) {
    super(code, message, M10_ERROR_STATUS[code]);
    this.name = "HopeStateError";
  }
}

/** Throw a {@link HopeStateError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M10ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new HopeStateError(code, message);
}
