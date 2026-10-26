// apps/web/src/modules/41-billing-commercial — what the assemble-claim screen shows when POST /api/v1/billing/commercial/claims/assemble
// refuses. Fixed words per status and code: the server's message text (which can name a diagnosis, a payer or a count) is never echoed.

/** Mirrors AssembleCommercialClaimBodySchema.clearinghouseKey. */
export const ASSEMBLE_CLEARINGHOUSE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const ASSEMBLE_FAILURES: Readonly<Record<string, string>> = {
  NON_COMMERCIAL_PRIMARY_PAYER:
    "This patient's primary coverage for these dates is not a commercial plan. Medicare claims are assembled under Medicare and Medicaid claims under Medicaid.",
  COMMERCIAL_PLAN_NOT_FOUND:
    "No payer plan is in effect for the patient's commercial payer on these dates. Add the plan under Supported payers, then assemble again.",
  COMMERCIAL_PLAN_AMBIGUOUS:
    "More than one plan of this payer covers the whole period. Choose the plan to bill.",
  COVERAGE_CHANGES_IN_WINDOW:
    "The patient's primary coverage changes inside these dates. Assemble each part separately, split at the change.",
  PATIENT_NOT_ELECTED: "No hospice election covers these dates. Check the dates and the election.",
  PATIENT_DECEASED_BEFORE_FROM:
    "The patient died before the first service date. Check the dates and the admission record.",
  DISCHARGE_CODES_UNRESOLVED:
    "The patient status at the end of the stay could not be worked out. Complete the discharge record in the admission, then assemble again.",
  ASSEMBLY_VALIDATION_FAILED:
    "No level of care is recorded for these dates, so there is nothing to bill. Record the level of care in the admission or change the dates.",
  VALIDATION_FAILED: "These details were not accepted. Check the dates.",
  AI_ACTOR_FORBIDDEN: "Claims can only be assembled by a person.",
};

export function describeAssembleFailure(status: number, code: string | undefined): string {
  const byCode = code ? ASSEMBLE_FAILURES[code] : undefined;
  if (byCode) return byCode;
  if (status === 503) return "Claim assembly is not available right now. Try again shortly.";
  if (status === 404) return "The provider entity, patient or plan is not in your scope.";
  if (status === 403) return "You are not allowed to assemble commercial claims.";
  if (status === 409) {
    return "A claim already covers part of these dates, or the request clashed with an earlier one. Open the claim queue to check.";
  }
  if (status === 422) return "These details were not accepted. Check the dates and the plan.";
  return "That did not go through. Check your connection and try again.";
}
