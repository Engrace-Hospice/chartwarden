// @chartwarden/types — M41 Billing — Commercial: closed sets for the payer and plan model (migration 1260).
// The database holds these as text + CHECK (the M25 precedent, no pgEnum); this file is the code-side mirror and
// `commercial-billing.test.ts` fails if the two drift. No PHI lives in any of these tables (ADR-0100, issue #721).

/**
 * X12 837I SBR09 claim filing indicator codes M41 may carry. Deliberately EXCLUDES Medicare, Medicaid, Medicare-risk and self-pay codes (TRICARE, FEHBP and VA stay allowed;
 * their M40 payers have kind 'other'):
 * MA/MB (Medicare, M23), MC (Medicaid, M24), 16 (HMO Medicare risk — hospice for a Medicare Advantage enrollee is billed
 * to the Medicare contractor, ADR-0100 D7), 09 (self-pay), 10 (central certification), TV (Title V).
 */
export const COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES = [
  "11", // other non-federal programs
  "12", // PPO
  "13", // POS
  "14", // EPO
  "15", // indemnity
  "17", // dental maintenance organization
  "AM", // automobile medical
  "BL", // Blue Cross / Blue Shield
  "CH", // CHAMPUS / TRICARE
  "CI", // commercial insurance company
  "DS", // disability
  "FI", // FEHBP
  "HM", // HMO
  "LM", // liability medical
  "OF", // other federal program
  "VA", // Veterans Affairs plan
  "WC", // workers' compensation
  "ZZ", // mutually defined
] as const;
export type CommercialClaimFilingIndicator =
  (typeof COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES)[number];

export function isCommercialClaimFilingIndicator(v: string): v is CommercialClaimFilingIndicator {
  return (COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES as readonly string[]).includes(v);
}

/** Whether a plan needs pre-authorization for hospice. `confirm_with_payer` is the honest default: unknown, not "no". */
export const COMMERCIAL_AUTHORIZATION_REQUIREMENT_VALUES = [
  "not_required",
  "required_at_admission",
  "required_per_level_of_care",
  "confirm_with_payer",
] as const;
export type CommercialAuthorizationRequirement =
  (typeof COMMERCIAL_AUTHORIZATION_REQUIREMENT_VALUES)[number];

export const COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite",
  "general_inpatient",
] as const;
export type CommercialHospiceLevelOfCare = (typeof COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES)[number];

/** Standard hospice revenue codes (NUBC 065x). A payer contract may map differently: the rate row stores its own code. */
export const COMMERCIAL_REVENUE_CODE_BY_LEVEL_OF_CARE: Readonly<
  Record<CommercialHospiceLevelOfCare, string>
> = {
  routine_home_care: "0651",
  continuous_home_care: "0652",
  inpatient_respite: "0655",
  general_inpatient: "0656",
};

export const COMMERCIAL_RATE_BASIS_VALUES = ["per_diem", "per_hour", "percent_of_charges"] as const;
export type CommercialRateBasis = (typeof COMMERCIAL_RATE_BASIS_VALUES)[number];

// ─── Enrollment, eligibility and the send gate (migration 1265, issue #724) ───────────────────────────────

/** A provider entity's enrollment with a payer on a clearinghouse (ADR-0053 D8, ADR-0100 D5). Only `enrolled` lets a send through. */
export const COMMERCIAL_ENROLLMENT_STATUS_VALUES = [
  "not_enrolled",
  "pending",
  "enrolled",
  "suspended",
] as const;
export type CommercialEnrollmentStatus = (typeof COMMERCIAL_ENROLLMENT_STATUS_VALUES)[number];

/** What a 271 said about coverage on the service date. `unknown` is a response we could not read as active or inactive. */
export const COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES = ["active", "inactive", "unknown"] as const;
export type CommercialEligibilityOutcome = (typeof COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES)[number];

/** What stale or missing eligibility does to claim validation: a warning (overridable) or a block. */
export const COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES = ["warn", "block"] as const;
export type CommercialEligibilityStalenessPolicy =
  (typeof COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES)[number];

/** Safe default: a warning. A tenant opts in to blocking per plan. */
export const DEFAULT_ELIGIBILITY_STALENESS_POLICY: CommercialEligibilityStalenessPolicy = "warn";
/**
 * Default age after which an eligibility check is stale. This is OUR default, matching M23's 30-day HETS window; it is not a
 * payer fact. Payers differ, so it is a per-plan setting (1..365 days).
 */
export const DEFAULT_ELIGIBILITY_MAX_AGE_DAYS = 30;
export const MAX_ELIGIBILITY_MAX_AGE_DAYS = 365;

/** Stable machine codes for a send that is refused before anything leaves the building (ADR-0100 D4, D5). */
export const COMMERCIAL_SEND_REFUSAL = {
  /** The platform clearinghouse binding is unbound (the port's own code, re-stated so callers need one import). */
  NOT_WIRED: "CH_NOT_WIRED",
  /** The plan has no route in effect on the service date for the clearinghouse the platform is bound to. */
  PAYER_NOT_ROUTED: "COMMERCIAL_PAYER_NOT_ROUTED",
  /** The provider entity has no `enrolled` enrollment in effect for this payer on this clearinghouse. */
  PROVIDER_NOT_ENROLLED: "COMMERCIAL_PROVIDER_NOT_ENROLLED",
} as const;
export type CommercialSendRefusalCode =
  (typeof COMMERCIAL_SEND_REFUSAL)[keyof typeof COMMERCIAL_SEND_REFUSAL];

/**
 * Every reason `POST .../submit` can refuse for (ADR-0100 D4/D5, ADR-0053 D10). The claim-level reasons join the transport-level
 * ones in {@link COMMERCIAL_SEND_REFUSAL}. Stable: the UI branches on them.
 */
export const COMMERCIAL_SEND_GATE_CODES = {
  CLAIM_NOT_READY: "COMMERCIAL_CLAIM_NOT_READY",
  VALIDATION_BLOCKED: "COMMERCIAL_VALIDATION_BLOCKED",
  AUTHORIZATION_NOT_SATISFIED: "COMMERCIAL_AUTHORIZATION_NOT_SATISFIED",
  ELIGIBILITY_NOT_CURRENT: "COMMERCIAL_ELIGIBILITY_NOT_CURRENT",
  NOT_WIRED: COMMERCIAL_SEND_REFUSAL.NOT_WIRED,
  PAYER_NOT_ROUTED: COMMERCIAL_SEND_REFUSAL.PAYER_NOT_ROUTED,
  ROUTE_CHANGED: "COMMERCIAL_ROUTE_CHANGED",
  PROVIDER_NOT_ENROLLED: COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED,
  /** The bound clearinghouse cannot carry a commercial claim (`direct_mac` drops files at a Medicare contractor's portal). */
  TRANSPORT_UNSUPPORTED: "COMMERCIAL_TRANSPORT_UNSUPPORTED",
  /** A submission of this claim is already queued, sent or in doubt (one live submission per claim). */
  SUBMISSION_IN_FLIGHT: "COMMERCIAL_SUBMISSION_IN_FLIGHT",
} as const;
export type CommercialSendGateCode =
  (typeof COMMERCIAL_SEND_GATE_CODES)[keyof typeof COMMERCIAL_SEND_GATE_CODES];

/**
 * Clearinghouse vendors that must never carry a commercial claim. `direct_mac` is the legacy MAC-portal drop (Medicare only, ADR-0053
 * D1): a commercial file there would reach the wrong payer, and ADR-0100 D4 allows no direct-to-payer channel.
 */
export const COMMERCIAL_UNSUPPORTED_CLEARINGHOUSES: readonly string[] = ["direct_mac"];

/** How a person settles an in-doubt submission (`POST .../reconcile`). */
export const COMMERCIAL_RECONCILE_OUTCOME_VALUES = ["received", "not_received"] as const;
export type CommercialReconcileOutcome = (typeof COMMERCIAL_RECONCILE_OUTCOME_VALUES)[number];

/** Other stable codes the eligibility check answers. */
export const COMMERCIAL_ELIGIBILITY_ERROR = {
  /** The patient has no coverage naming this plan's payer on the service date, so there is no member id to ask about. */
  COVERAGE_NOT_FOUND: "COMMERCIAL_COVERAGE_NOT_FOUND",
  /** The clearinghouse could not answer (outage, not provisioned, not implemented for commercial). Nothing is stored. */
  CLEARINGHOUSE_UNAVAILABLE: "COMMERCIAL_ELIGIBILITY_UNAVAILABLE",
  /** The clearinghouse refused the request as malformed for this vendor. */
  CLEARINGHOUSE_REJECTED: "COMMERCIAL_ELIGIBILITY_REJECTED",
} as const;

/** Rule id the claim-validation lane (#722) reports freshness under. */
export const COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID = "M41.ELIGIBILITY.FRESHNESS";

/** Permission keys (spec section 6). */
export const COMMERCIAL_BILLING_PERMISSIONS = {
  READ: "commercial_billing.read",
  WRITE: "commercial_billing.write",
  SUBMIT: "commercial_billing.submit",
  OVERRIDE_VALIDATION: "commercial_billing.override_validation",
  MANAGE_ENROLLMENT: "commercial_billing.manage_enrollment",
} as const;
export type CommercialBillingPermissionKey =
  (typeof COMMERCIAL_BILLING_PERMISSIONS)[keyof typeof COMMERCIAL_BILLING_PERMISSIONS];
