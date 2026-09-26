// @wardenx/assessments — M9 domain failure-code catalog (§4.4, M9-T03).
//
// Every guard / validation failure in the M9 assessment domain raises an `AssessmentStateError`
// carrying the machine-readable code the spec's §4.4 table enumerates (e.g. `CORRECTION_MISMATCH`,
// `COSIGN_REQUIRED`, `SCORE_OUT_OF_RANGE`). The error extends the M1 `WardenXError` envelope base
// (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders it
// with the precise code + HTTP status with no cross-module import edge. The code→status mapping is the
// single source mirrored from §4.4; nothing transitions on a string match — each code is an enumerated
// constant (the M8 lifecycle convention). The route layer (M9-T05) reuses these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The §4.4 M9-specific failure-code catalog → canonical HTTP status, plus the domain-internal
 * lifecycle codes (correction / cosignature / significant-change transitions) the pure machines raise. */
export const M9_ERROR_STATUS = {
  // §4.4 — recording / disclosure guards (full enforcement at the route, M9-T05)
  INACTIVE_ADMISSION: 422,
  BEFORE_ADMISSION: 422,
  // #44 — the M6 status seam REFUSED to project the admission (a required fact is missing on the
  // row), as distinct from the admission being inactive, absent, or another tenant's. Not a §4.4
  // code: it describes the state of the RECORD, not of the capture. 422 like its neighbours — the
  // request is well-formed and the caller cannot fix it by retrying, but the admission can be
  // repaired. It exists because both cases used to raise INACTIVE_ADMISSION, which told a clinician
  // an active admission was inactive and hid the real cause from whoever had to fix it.
  ADMISSION_PROJECTION_GAP: 422,
  SCALE_NOT_ENABLED: 403,
  SCALE_LICENSE_MISSING: 403,
  DISCIPLINE_NOT_ELIGIBLE: 403,
  SUD_DISCLOSURE_DENIED: 403,
  DPOA_CONSENT_REQUIRED: 403,
  // §4.4 — server-authoritative scoring sanity (D6): an out-of-published-range computed score is a
  // scoring-function bug, never user error — always 500, client retry won't help.
  SCORE_OUT_OF_RANGE: 500,
  // §4.4 / §2.2.1 — correction-chain integrity (the append-only amendment path).
  CORRECTION_MISMATCH: 422,
  CORRECTION_TARGET_NOT_ACTIVE: 409,
  STALE_VERSION: 412,
  // §4.4 / §7.4 — the cosignature read gate (a consumer surface refuses an un-cosigned row).
  COSIGN_REQUIRED: 412,
  // Domain-internal lifecycle codes (the pure machines below; not in the §4.4 client table).
  // A significant-change event acked/escalated from a state that does not accept it (§2.2.2 graph).
  ILLEGAL_CHANGE_TRANSITION: 409,
  // Escalation requested for a non-CRITICAL rule (only PPS-drop / Braden-low / NYHA-IV escalate, §2.2.2).
  CHANGE_NOT_ESCALATABLE: 422,
  // D2 / §2.3 — a tenant `scale_policy` significant-change override that would LOOSEN a platform floor
  // (raise a `≥` trigger, lower a `≤` trigger, or require a larger delta) or pierce the clinical floor.
  // Overrides may only tighten; a loosening override is rejected (422), never silently clamped.
  SIGNIFICANT_CHANGE_FLOOR_VIOLATION: 422,
  // §7.4 / §6 — cosignature attest guards.
  NOT_COSIGN_ELIGIBLE: 403,
  ALREADY_COSIGNED: 409,
  COSIGN_NOT_REQUIRED: 422,
  // A score was requested for a scale whose per-scale module has not landed yet (PPS/FAST/PAINAD/ESAS-r
  // ship in M9-T03; the remaining ten scales' scoring lands with the routes/tests). Internal 500.
  SCALE_SCORER_UNAVAILABLE: 500,
} as const;

/** A machine-readable M9 assessment-domain failure code (§4.4 + the domain-internal lifecycle codes). */
export type M9ErrorCode = keyof typeof M9_ERROR_STATUS;

/**
 * A guard / validation failure in the M9 assessment domain. Carries the precise §4.4 `code` so the UI
 * renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class AssessmentStateError extends WardenXError {
  constructor(code: M9ErrorCode, message: string) {
    super(code, message, M9_ERROR_STATUS[code]);
    this.name = "AssessmentStateError";
  }
}

/** Throw an {@link AssessmentStateError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M9ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new AssessmentStateError(code, message);
}
