// @wardenx/dosespot — M12 EPCS-architecture failure-code catalog (§2.4 D18, §1311.115/116/120/300, M12-T05).
//
// Every guard / validation failure in the pure EPCS architecture (the cert gate, the IAL2 tracker, the DEA
// schedule-authorization check, and the 60-second 2FA signing-session submachine) raises an `EpcsStateError`
// carrying the machine-readable code below. The error extends the M1 `WardenXError` envelope base
// (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify error handler renders it with
// the precise code + HTTP status with no cross-module import edge (the M11/M12 lifecycle convention). The
// EPCS controlled-substance routes (M12-T08) are themselves behind the OFF `dosespot.epcs` flag in Phase 1
// (deny-stub) and reuse these codes verbatim; nothing transitions on a string match.
//
// Codes overlap deliberately with the medication-order-lifecycle catalog (`EPCS_NOT_CERTIFIED`,
// `EPCS_PRESCRIBER_NOT_VERIFIED`, `DEA_SCHEDULE_NOT_AUTHORIZED`, `EPCS_2FA_EXPIRED`): the lifecycle machine
// repeats the strongest guards inline (defence in depth), while this submodule owns the route-level EPCS
// pre-checks and the `epcs_signing_attempt` records-of-application path (§1311.205). Same wire code, two
// enforcement points.
import { WardenXError } from "@wardenx/types";

/** The M12 EPCS-architecture failure-code catalog → canonical HTTP status. */
export const M12_EPCS_ERROR_STATUS = {
  // §2.4 D18 / Phase-1 deny-stub — the `dosespot.epcs` platform flag is OFF; the EPCS path is unavailable.
  EPCS_FEATURE_DISABLED: 403,
  // §2.4 D18 / §1311.300 — the tenant's `epcs_certification_status` is `not_certified` / `audit_in_progress`.
  EPCS_NOT_CERTIFIED: 403,
  // §2.4 D18 / §1311.300 — the tenant's EPCS certification has been `revoked` (explicit alert path).
  EPCS_CERTIFICATION_REVOKED: 403,
  // §2.4 §1311.115 — the prescriber's IAL2 identity proofing is not `'verified'`.
  EPCS_PRESCRIBER_NOT_VERIFIED: 403,
  // §2.4 §1311.120 / §4.7 `dea_schedule_authorized` — the prescriber is not authorized for this DEA schedule.
  DEA_SCHEDULE_NOT_AUTHORIZED: 403,
  // §2.4 §1311.116 — the EPCS two-factor challenge was not completed within the 60s window.
  EPCS_2FA_EXPIRED: 422,
  // §2.4 §1311.116 — the completion request's nonce does not match the pending signing attempt.
  EPCS_2FA_NONCE_MISMATCH: 422,
  // §2.4 §1311.116 — no second-factor proof was supplied on the completion request.
  EPCS_SECOND_FACTOR_REQUIRED: 422,
  // §2.4 §1311.116 / §1311.205 — the `epcs_signing_attempt` is not in the `pending` outcome (already resolved).
  EPCS_SIGNING_ATTEMPT_NOT_PENDING: 409,
} as const;

/** A machine-readable M12 EPCS-architecture failure code (§2.4). */
export type M12EpcsErrorCode = keyof typeof M12_EPCS_ERROR_STATUS;

/**
 * A guard / validation failure in the M12 EPCS architecture. Carries the precise `code` so the UI renders
 * an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every guard failure
 * surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class EpcsStateError extends WardenXError {
  constructor(code: M12EpcsErrorCode, message: string) {
    super(code, message, M12_EPCS_ERROR_STATUS[code]);
    this.name = "EpcsStateError";
  }
}

/** Throw an {@link EpcsStateError} when `condition` is false (guard helper). */
export function requireEpcs(
  condition: boolean,
  code: M12EpcsErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new EpcsStateError(code, message);
}
