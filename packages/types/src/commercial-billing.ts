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
