// @wardenx/dosespot — M12 medication-order lifecycle failure-code catalog (§2.2 D2 / §2.3, M12-T03).
//
// Every guard / validation failure in the pure medication-order lifecycle domain raises a
// `MedicationOrderStateError` carrying the machine-readable code below. The error extends the M1
// `WardenXError` envelope base (`@wardenx/types` — NOT the banned `packages/foundation`) so the M1 Fastify
// error handler renders it with the precise code + HTTP status with no cross-module import edge (the
// M11/M10 lifecycle convention). Nothing transitions on a string match — each code is an enumerated
// constant; the §3 DB triggers (M12-T02) repeat the strongest of these at the schema layer as defense in
// depth. The route layer (M12-T08) reuses these codes verbatim.
import { WardenXError } from "@wardenx/types";

/** The M12 medication-order-lifecycle failure-code catalog → canonical HTTP status. */
export const M12_ERROR_STATUS = {
  // §2.2 — the lifecycle transition graph (an event from a state that does not accept it).
  ILLEGAL_MEDICATION_ORDER_TRANSITION: 409,
  // §2.2 `requestSignature` — the per-class `data` fields are not yet complete.
  MEDICATION_ORDER_REQUIRED_DATA_INCOMPLETE: 422,
  // §2.2 `requestSignature` — the M12 allergy interaction check has not passed.
  ALLERGY_CHECK_NOT_PASSED: 422,
  // §2.2 `requestSignature` — the SUD-treatment-medication consent gate (§7.8 / M39) is not satisfied.
  SUD_CONSENT_REQUIRED: 412,
  // §2.2 / §2.4 D18 — the tenant's `epcs_certification_status` is not `'certified'`; controlled-substance
  // prescribing is blocked for this tenant.
  EPCS_NOT_CERTIFIED: 403,
  // §2.2 / §4.7 `prescriber_eligible` — the drafting/prescribing discipline may not author this med class.
  PRESCRIBER_NOT_ELIGIBLE: 403,
  // §2.2 / §4.7 — the signing discipline is not eligible to sign this medication order (M11 seam).
  SIGNER_NOT_ELIGIBLE: 403,
  // §2.2 — the signer is neither the named ordering physician nor an authorized on-behalf proxy.
  SIGNER_NOT_ORDERING_PHYSICIAN: 403,
  // §2.2 — a controlled-substance order took the standard `sign` path instead of `signControlled` (EPCS).
  SIGN_REQUIRES_EPCS: 422,
  // §2.2 — `signControlled` was attempted on a non-controlled order (no EPCS branch required).
  NOT_CONTROLLED_FOR_EPCS: 422,
  // §2.4 / §4.7 `dea_schedule_authorized` — the prescriber is not authorized for this DEA schedule.
  DEA_SCHEDULE_NOT_AUTHORIZED: 403,
  // §2.4 §1311.115 — the prescriber's IAL2 identity proofing is not `'verified'`.
  EPCS_PRESCRIBER_NOT_VERIFIED: 403,
  // §2.4 §1311.116 — the EPCS two-factor challenge was not completed within the 60s window.
  EPCS_2FA_EXPIRED: 422,
  // §2.3 D18 — a controlled-substance verbal medication order (Phase-1 feature-flag OFF).
  EPCS_VERBAL_NOT_PERMITTED: 403,
  // §2.3 — the recording actor lacks `prescribing.verbal.record` / is not RN+.
  VERBAL_RECORDER_NOT_ELIGIBLE: 403,
  // §2.3 — the named prescriber is not present on the order being recorded as verbal.
  VERBAL_PRESCRIBER_REQUIRED: 422,
  // §2.3 — the recording RN's verbal-communication attestation is missing.
  VERBAL_ATTESTATION_REQUIRED: 422,
  // §2.2 — `expire` fired before `now() >= verbal_order.deadline_at` (M11 worker clock guard).
  VERBAL_DEADLINE_NOT_REACHED: 422,
  // §2.3 — the verbal follow-up signer is not the named ordering prescriber (no on-behalf in verbal flow).
  VERBAL_SIGNER_NOT_NAMED_PRESCRIBER: 403,
  // §2.3 — the verbal follow-up signature was attempted past M11's `verbal_order.deadline_at`.
  VERBAL_DEADLINE_PASSED: 409,
  // §2.2 `withdraw` — actor is not the drafter, supervisor, or signer.
  WITHDRAW_NOT_PERMITTED: 403,
  // §2.2 `discardDraft` — actor is neither the drafter nor a supervisor.
  DISCARD_NOT_PERMITTED: 403,
  // §2.2 `discardDraft` — the draft is referenced by another `medication_order` and cannot be discarded.
  MEDICATION_ORDER_HAS_EXTERNAL_REFERENCES: 409,
  // §2.2 `complete` — the one-shot / no-refill completion criterion is not met.
  COMPLETION_CRITERION_NOT_MET: 422,
  // §2.2 — a transition reserved to the system worker / webhook handler was attempted by a human actor.
  NOT_SYSTEM_ACTOR: 403,
} as const;

/** A machine-readable M12 medication-order-lifecycle failure code (§2.2 / §2.3). */
export type M12ErrorCode = keyof typeof M12_ERROR_STATUS;

/**
 * A guard / validation failure in the M12 medication-order-lifecycle domain. Carries the precise `code`
 * so the UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Every
 * guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class MedicationOrderStateError extends WardenXError {
  constructor(code: M12ErrorCode, message: string) {
    super(code, message, M12_ERROR_STATUS[code]);
    this.name = "MedicationOrderStateError";
  }
}

/** Throw a {@link MedicationOrderStateError} when `condition` is false (guard helper). */
export function require_(
  condition: boolean,
  code: M12ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new MedicationOrderStateError(code, message);
}
