// apps/backend/src/modules/06-admission/state-machines/errors.ts — M6-T04 (§2.3, §2.4).
//
// Every guard / validation failure in the M6 domain raises a `AdmissionStateError` carrying the
// machine-readable code the spec's §2.4 table enumerates (e.g. `PATIENT_ALREADY_ELECTED`,
// `F2F_OUTSIDE_WINDOW`). The error extends the M1 `ChartWardenError` envelope base (packages/types — NOT
// the banned packages/foundation) so the M1 Fastify error handler renders it with the precise code +
// HTTP status the UI keys its message off, with no cross-module import edge. The code→status mapping
// is the single source mirrored from §2.4; nothing transitions on a string match — each code is an
// enumerated constant.
import { type ErrorDetailType, ChartWardenError } from "@chartwarden/types";

/** The full §2.4 + §2.3 machine-readable failure-code catalog → canonical HTTP status. */
export const M6_ERROR_STATUS = {
  // Election (§2.4.1 R-EL-*)
  REPRESENTATIVE_AUTHORITY_MISSING: 403,
  PATIENT_ALREADY_ELECTED: 409,
  BENEFIT_PERIOD_SEQUENCE_GAP: 409,
  CURATIVE_CARE_ACK_REQUIRED: 422,
  ELECTION_PERIOD_OVERLAP: 409,
  // The first benefit period of a NEW admission (intake/benefit-period.ts): malformed number / HETS date (422).
  BENEFIT_PERIOD_INVALID: 422,
  BENEFIT_PERIOD_CONFIRMATION_DATE_REQUIRED: 422,
  BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID: 422,
  // A readmission must start from a live-discharged earlier admission of the same patient (409).
  READMISSION_SOURCE_INVALID: 409,
  // A period holds one LIVE election statement (`election_statement_period_idx`, partial — voided rows
  // excluded): a second draft beside a live one is a conflict, never a raw unique_violation (42 CFR 418.24 — one election per period).
  ELECTION_STATEMENT_CONFLICT: 409,
  // CTI (§2.4.1 R-CTI-*)
  TERMINAL_DX_NOT_ALLOWABLE: 422,
  ATTENDING_SIGNATURE_REQUIRED: 409,
  CTI_LATE_REASON_REQUIRED: 422,
  CTI_SIGNER_MISMATCH: 403,
  CTI_NARRATIVE_TOO_SHORT: 422,
  CTI_PERIOD_START_OUT_OF_WINDOW: 422,
  CTI_VOID_FORBIDDEN: 409,
  // F2F (§2.4.1 R-F2F-*)
  F2F_INVALID_PERFORMER: 422,
  F2F_OUTSIDE_WINDOW: 409,
  F2F_OVERRIDE_FORBIDDEN: 403,
  F2F_OVERRIDE_REASON_TOO_SHORT: 422,
  F2F_REQUIRED_FOR_RECERT: 409,
  // F-226 - the real encounter date is captured at completion: a future / absurdly old date is malformed
  // input (422); a period whose start cannot be derived yet cannot have its window computed (409).
  F2F_ENCOUNTER_DATE_INVALID: 422,
  F2F_PERIOD_START_UNKNOWN: 409,
  F2F_ATTESTATION_TOO_SHORT: 422,
  // FY2027 CoP (R-F2F-05 / R-F2F-06): telehealth modality limits (§ 418.22(a)(4)(ii)) and the signed
  // clinical-note attestation alternative (§ 418.22(b)(4)).
  F2F_TELEHEALTH_NOT_PERMITTED: 422,
  F2F_TELEHEALTH_ATTESTATION_REQUIRED: 422,
  F2F_ATTESTATION_NOTE_INVALID: 422,
  F2F_ATTESTATION_SOURCE_REQUIRED: 422,
  // MBPM ch. 9 §20.1(5)(d) — the exceptional-circumstance path needs period 3+ and a documented reason.
  F2F_EXCEPTION_INVALID: 422,
  // Admission (§2.4.1 R-ADM-*)
  NOTICE_OF_RIGHTS_REQUIRED: 409,
  INITIAL_ASSESSMENT_OVERDUE: 409,
  FOR_CAUSE_REQUIRES_COSIGN: 409,
  ELECTION_STATEMENT_REQUIRED: 409,
  CERTIFICATION_REQUIRED: 409,
  PRIVACY_FLAG_BLOCK: 409,
  HOLD_REASON_REQUIRED: 422,
  // Level of care (§2.4.1 R-LCP-*)
  GIP_DOCUMENTATION_INSUFFICIENT: 422,
  // D12 — a GIP level-of-care request missing any of the three required attestations (412 per the decision).
  GIP_DOCUMENTATION_INCOMPLETE: 412,
  IPU_FACILITY_REQUIRED: 422,
  LEVEL_OF_CARE_OVERLAP: 409,
  // Revocation / transfer / discharge (§2.4.1 R-RV/XFR/DC-*)
  REVOCATION_EFFECTIVE_BEFORE_SIGNED: 422,
  TRANSFER_LIMIT_EXCEEDED: 409,
  TRANSFER_IN_SOURCE_INVALID: 422,
  // CMS Pub. 100-04 ch. 11 §20.1.3: transfers are not allowed from the same provider (same CCN).
  TRANSFER_SAME_PROVIDER: 422,
  // The carried sequence must follow every period already on the admission (42 CFR 418.28 — the counter
  // never restarts); a transfer-in whose inherited/next period collides with an existing one is a conflict.
  TRANSFER_IN_PERIOD_CONFLICT: 409,
  DEATH_CERTIFIER_INVALID: 422,
  DISCHARGE_BEFORE_ADMISSION: 422,
  // Discharge reason-specific capture gates (§6.3 / D11)
  NARRATIVE_REQUIRED_FOR_CAUSE: 412,
  DISCHARGE_NARRATIVE_TOO_SHORT: 422,
  // 42 CFR 418.26(b) / 418.25(a) physician signer set (physician-authority.ts)
  DISCHARGE_ORDER_REQUIRED: 422,
  DISCHARGE_ORDER_TIMING_INVALID: 422,
  PHYSICIAN_SIGNER_INVALID: 422,
  ADMISSION_RECOMMENDATION_INVALID: 422,
  ATTENDING_CONSULT_NOTE_REQUIRED: 422,
  // Claim patient discharge status 40/41/42 needs the place of death (CMS Pub. 100-04 Ch. 11 §30.3).
  PLACE_OF_DEATH_REQUIRED: 422,
  PLACE_OF_DEATH_NOT_ALLOWED: 422,
  // Claim patient status 50/51 needs where the receiving hospice cares for the patient.
  RECEIVING_CARE_SETTING_REQUIRED: 422,
  // After-the-fact discharge details (discharge/discharge-details.ts): replacing a recorded value needs a
  // correction reason; the detail must belong to the event kind (a death / a transfer-out).
  DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED: 409,
  DISCHARGE_DETAIL_NOT_APPLICABLE: 422,
  // Compliance windows (§2.4.1 R-CW-*)
  WINDOW_OVERRIDE_FORBIDDEN: 403,
  // FY2027 election statement addendum (42 CFR 418.24(c)/(d); state-machines/election-addendum.ts)
  ADDENDUM_INCOMPLETE: 422,
  ADDENDUM_ITEMS_CONFLICT: 422,
  ADDENDUM_REFUSAL_REASON_REQUIRED: 422,
  ADDENDUM_REPRESENTATIVE_REQUIRED: 422,
  ADDENDUM_NOT_APPLICABLE: 409,
  // A scanned signed paper copy attached to a never-furnished draft must say when the paper was handed over
  // ((c)(10) date furnished); dates on paper are back-entered, never in the future, furnish <= acknowledgement.
  ADDENDUM_FURNISH_DATE_REQUIRED: 422,
  ADDENDUM_DATE_INVALID: 422,
  // Structural — an event dispatched from a state that does not accept it (§2.3 graph).
  ILLEGAL_TRANSITION: 409,
} as const;

/** The caller-facing sentence for `ELECTION_STATEMENT_CONFLICT` (shared by the pre-check and the
 *  `election_statement_period_idx` unique-violation backstop, in both service backends). */
export const ELECTION_STATEMENT_CONFLICT_MESSAGE =
  "This benefit period already has an election statement. Open the existing statement instead of " +
  "drafting a second one.";

/** A machine-readable M6 domain failure code (§2.4 / §2.3). */
export type M6ErrorCode = keyof typeof M6_ERROR_STATUS;

/**
 * A guard / validation failure in the M6 domain. Carries the precise §2.4 `code` so the UI renders an
 * exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.3 every guard
 * failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class AdmissionStateError extends ChartWardenError {
  constructor(code: M6ErrorCode, message: string, details?: ErrorDetailType[]) {
    super(code, message, M6_ERROR_STATUS[code], details);
    this.name = "AdmissionStateError";
  }
}

/** Throw an {@link AdmissionStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M6ErrorCode, message: string): void {
  if (!condition) throw new AdmissionStateError(code, message);
}
