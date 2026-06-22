// @wardenx/emar — M13 administration-lifecycle failure-code catalog (§2.2 D6 / §5.11, M13-T03).
//
// Every guard / validation failure in the pure administration-lifecycle domain raises an
// `AdministrationStateError` carrying the machine-readable code below. The error extends the M1
// `WardenXError` envelope base (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify
// error handler renders it with the precise code + HTTP status with no cross-module import edge (the
// M11/M12 lifecycle convention). Nothing transitions on a string match — each code is an enumerated
// constant; the §3 DB triggers (M13-T02) repeat the strongest of these at the schema layer as defense in
// depth. The route layer (M13-T08) reuses these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The M13 administration-lifecycle failure-code catalog → canonical HTTP status. */
export const M13_ERROR_STATUS = {
  // §2.2 — the lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_ADMINISTRATION_TRANSITION: 409,
  // §2.2 `recordAdministration` / §4.7 — the administering clinician is not eligible for this med class.
  ADMINISTERING_CLINICIAN_NOT_ELIGIBLE: 403,
  // §2.2 / §2.6 D7 — the witness for a controlled-substance administration is not eligible.
  CONTROLLED_WITNESS_NOT_ELIGIBLE: 403,
  // §2.2 / D6 — M12's `getAdministrationContext` returned `allowAdministration=false` (order not active).
  ADMINISTRATION_BLOCKED: 422,
  // §2.2 / §5.11 — the five-rights validation failed (right patient/drug/dose/route/time).
  FIVE_RIGHTS_VIOLATION: 422,
  // §2.9 BCMA — the bedside barcode scan re-derived an unsafe match_result (wrong_patient/wrong_drug/expired).
  BARCODE_VERIFICATION_FAILED: 422,
  // §2.2 / D8 — the late-entry tier could not be resolved against (administeredAt, recordedAt).
  LATE_ENTRY_TIER_UNRESOLVED: 422,
  // §2.7 D5 — the comfort-kit drawdown decrement would go negative; the administration is rejected.
  KIT_INSUFFICIENT_QUANTITY: 422,
  // §2.9 D10 — the caregiver-attested path requires an M31 portal `caregiver_attested` actor session.
  CAREGIVER_ACTOR_REQUIRED: 403,
  // §2.9 D10 — the caregiver attestation text is missing on the caregiver-attested write.
  CAREGIVER_ATTESTATION_REQUIRED: 422,
  // §2.9 D10 — only the patient's RN case manager may acknowledge a caregiver-attested administration.
  CASE_MANAGER_ACK_NOT_PERMITTED: 403,
  // §2.2 — the void path requires the `administration.void` permission (RN case manager + supervisor).
  VOID_NOT_PERMITTED: 403,
  // §2.2 — the void path requires completed step-up re-authentication.
  VOID_STEP_UP_REQUIRED: 403,
  // §2.2 — the void reason is shorter than the 40-character minimum.
  VOID_REASON_TOO_SHORT: 422,
  // §2.2 — a transition reserved to the system (correction trigger) was attempted by a human actor.
  NOT_SYSTEM_ACTOR: 403,
  // §2.4 D3 — a PRN dose was requested inside the order's minimum-interval window without an override.
  PRN_INTERVAL_VIOLATION: 422,
  // §2.4 D3 — the PRN minimum-interval override requires the `prn_interval_override` permission.
  PRN_INTERVAL_OVERRIDE_NOT_PERMITTED: 403,
  // §2.4 D3 — the PRN minimum-interval override reason is shorter than the 40-character minimum.
  PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT: 422,
  // §7.4 — the witness-attestation token failed HMAC verification (tampered or wrong tenant secret).
  WITNESS_TOKEN_INVALID: 401,
  // §7.4 — the witness-attestation token is past its 60-second TTL (or its issued-at is in the future).
  WITNESS_TOKEN_EXPIRED: 401,
  // §7.4 — the witness-attestation token was minted for a different (patient, order, clinician) scope.
  WITNESS_TOKEN_SCOPE_MISMATCH: 401,
  // §2.8 D17 — a per-line reconciliation decision is illegal for the line's source (e.g. `new_order` on an
  // already-active M12 order).
  RECONCILIATION_DECISION_INVALID: 422,
  // §2.8 D17 — finalization was attempted while one or more worksheet lines are still undecided.
  RECONCILIATION_NOT_FINALIZABLE: 422,
  // §2.8 D17 — a worksheet lifecycle event was attempted from a terminal/illegal status (already finalized/voided).
  ILLEGAL_RECONCILIATION_TRANSITION: 409,
  // §2.11 D11 — an IV-continuous segment was recorded out of sequence (e.g. `rate_change` before `start`).
  ILLEGAL_IV_SESSION_TRANSITION: 409,
  // §2.11 D11 — an `iv_continuous_rate_change` `newRate` fell outside the order's `[minRate, maxRate]` bounds.
  IV_RATE_OUT_OF_RANGE: 422,
} as const;

/** A machine-readable M13 administration-lifecycle failure code (§2.2 / §5.11). */
export type M13ErrorCode = keyof typeof M13_ERROR_STATUS;

/**
 * A guard / validation failure in the M13 administration-lifecycle domain. Carries the precise `code`
 * so the UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class AdministrationStateError extends WardenXError {
  constructor(code: M13ErrorCode, message: string) {
    super(code, message, M13_ERROR_STATUS[code]);
    this.name = "AdministrationStateError";
  }
}

/** Throw an {@link AdministrationStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M13ErrorCode, message: string): asserts condition {
  if (!condition) throw new AdministrationStateError(code, message);
}
