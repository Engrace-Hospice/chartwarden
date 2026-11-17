// @chartwarden/hope — M10 domain failure-code catalog (§4.4, M10-T03).
//
// Every guard / validation failure in the M10 HOPE domain raises a `HopeStateError` carrying the
// machine-readable code the spec's §4.4 table enumerates (e.g. `M10_TIMEPOINT_EXPIRED`,
// `M10_DISCIPLINE_NOT_PERMITTED`, `M10_SFV_PAST_DUE`). The error extends the M1 `ChartWardenError` envelope
// base (`@chartwarden/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders
// it with the precise code + HTTP status with no cross-module import edge. The code→status mapping is the
// single source mirrored from §4.4; nothing transitions on a string match — each code is an enumerated
// constant (the M8/M9 lifecycle convention). The route layer (M10-T06) reuses these codes verbatim.
import { ChartWardenError, HOPE_ATTESTATION_VERSION } from "@chartwarden/types";

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
  // #45 — the M6 status seam ANSWERED but could not tell M10 WHOSE admission this is (the row is missing a
  // fact the seam projects non-null, or the admission is another tenant's). On the SFV completion path a seam
  // that THROWS (absent, denying or down) is NOT this code: it is a retryable 503 `DEGRADED` (see
  // `resolveSfvAdmissionPatient`), and a real outage usually answers 404 earlier, in `hope.scope`. Not a
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
  // R-05 — a completion would sign an RFA-04 whose J2053 follow-up content (J2053A-H) is missing or
  // incomplete: the SFV is not closed and nothing is written. 422: well-formed request, content incomplete.
  M10_SFV_COMPLETION_INCOMPLETE: 422,
  // R-05 — a HOPE record signature (POST /sign, and the RFA-04 SFV completion which inserts an already-signed
  // row) needs the signer's explicit attestation (`attestationConfirmed === true`, strictly the boolean).
  M10_ATTESTATION_REQUIRED: 422,
  // The signer attested to wording that is no longer the current attestation (`attestationVersion` in the request is
  // not `HOPE_ATTESTATION_VERSION`): nothing is written, and the signer must reload and read the new wording. 409: the
  // request is well-formed but conflicts with the server's current state.
  M10_ATTESTATION_STALE: 409,
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
  // Recording the CMS (iQIES) result of a manual upload.
  M10_SUBMISSION_RESULT_NOT_UPLOADED: 409,
  M10_SUBMISSION_RESULT_ALREADY_RECORDED: 409,
  M10_SUBMISSION_RESULT_NO_MATCH: 422,
  // A batch packaged before package hashes were recorded cannot be marked uploaded (no integrity hash).
  M10_SUBMISSION_PACKAGE_HASH_MISSING: 409,
  // R-08 — only a package that was never marked uploaded (packaged/exported) can be cancelled; a cancelled
  // package is dead: it cannot be downloaded, marked uploaded or have a CMS result recorded against it.
  M10_SUBMISSION_CANCEL_NOT_ALLOWED: 409,
  M10_SUBMISSION_CANCELLED: 409,
  M10_IQIES_ADAPTER_UNAVAILABLE: 503,
  // A record write that could not take the record's row lock within the bounded lock wait (another request holds it).
  // The step that timed out was not applied (an earlier step of the same request may have been): check the current
  // state, then send the request again. The idempotency middleware releases the Idempotency-Key for this code (unless
  // an earlier step already committed), so the same key may be reused.
  M10_RECORD_BUSY: 409,
  // No HOPE spec version is in force on the record's target date (before every loaded spec, or in a gap between two), so
  // the record cannot be opened, recorded or its SFV completion judged: there is nothing to judge its values against.
  // A data fault an administrator fixes by loading the spec that covers the date, not a server error and not something a
  // retry fixes. 422; the message names no date and no value.
  M10_SPEC_NOT_IN_FORCE: 422,
} as const;

/** A machine-readable M10 HOPE-domain failure code (§4.4). */
export type M10ErrorCode = keyof typeof M10_ERROR_STATUS;

/**
 * A guard / validation failure in the M10 HOPE domain. Carries the precise §4.4 `code` so the UI renders
 * an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard failure
 * surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class HopeStateError extends ChartWardenError {
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

/**
 * R-05: the signature attestation guard, shared by the route (on the RAW body, before any coercion) and by
 * both service layers. Strictly the boolean `true`: `"true"`, `1` and `"1"` are what `Value.Convert` turns
 * into `true` on the way to a TypeBox check, so a typed schema alone cannot enforce it.
 */
export function requireAttestation(
  confirmed: unknown,
  attestedVersion?: unknown,
): asserts confirmed is true {
  require_(
    confirmed === true,
    "M10_ATTESTATION_REQUIRED",
    "Signing a HOPE record requires the signer's attestation (attestationConfirmed: true).",
  );
  // The version is optional (a client that sends none is attesting to the server's current wording), but one that IS
  // sent must be the current one, checked here, before any write.
  require_(
    attestedVersion === undefined || attestedVersion === HOPE_ATTESTATION_VERSION,
    "M10_ATTESTATION_STALE",
    "The attestation wording has changed since you opened this dialog. Reload and review the current wording before signing again.",
  );
}
