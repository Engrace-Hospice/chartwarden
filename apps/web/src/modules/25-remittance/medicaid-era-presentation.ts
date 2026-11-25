/** Safe, allowlisted presentation helpers for the L6D Medicaid ERA observation contract. */

export interface PresentedAdjustment {
  readonly key: string;
  readonly groupCode?: string;
  readonly reasonCode: string;
  readonly amountCents: number | null;
  readonly lineIndex?: number;
}

export interface PresentedClaimObservation {
  readonly decision: string;
  readonly reasonCode: string;
  readonly matchStatus: string;
  readonly matchedClaimId: string | null;
  readonly claimVersion: number | null;
  readonly amounts: Readonly<Record<string, number | null>>;
  readonly providerAdjustments: readonly PresentedAdjustment[];
  readonly claimAdjustments: readonly PresentedAdjustment[];
  readonly serviceLineAdjustments: readonly PresentedAdjustment[];
  readonly unresolvedRequirements: readonly string[];
  readonly evidenceReferenceCount: number;
}

export interface PresentedSummary {
  readonly transactionSetCount: number | null;
  readonly claims: readonly PresentedClaimObservation[];
}

const DECISIONS = new Set([
  "payment_reported",
  "full_payment_indicated_review_required",
  "partial_payment",
  "denial",
  "mixed_service_line_outcomes",
  "adjustment_review",
  "reversal_or_recoupment_review",
  "exact_duplicate",
  "possible_duplicate",
  "source_identity_conflict",
  "unmatched_or_ambiguous",
  "inconsistent_financial_totals",
  "provider_adjustment_review",
  "source_unverified",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT_KEYS = [
  "claimChargeCents",
  "claimPaidCents",
  "patientResponsibilityCents",
  "providerAdjustmentCents",
  "reportedPaymentCents",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cents(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function adjustments(
  value: unknown,
  withGroup: boolean,
  withLine: boolean,
): PresentedAdjustment[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: PresentedAdjustment[] = [];
  for (const raw of value) {
    const item = record(raw);
    const reasonCode = string(item?.reasonCode) ?? string(item?.reason);
    const amountCents = cents(item?.amountCents);
    if (!item || !reasonCode || amountCents === undefined) return null;
    const groupCode = withGroup ? string(item.groupCode) : null;
    const lineIndex = withLine ? item.lineIndex : null;
    if (withGroup && !groupCode) return null;
    if (
      withLine &&
      !(typeof lineIndex === "number" && Number.isSafeInteger(lineIndex) && lineIndex >= 0)
    )
      return null;
    result.push({
      key: `${withLine ? "line" : withGroup ? "claim" : "provider"}-${result.length}`,
      ...(groupCode ? { groupCode } : {}),
      reasonCode,
      amountCents,
      ...(typeof lineIndex === "number" ? { lineIndex } : {}),
    });
  }
  return result;
}

/**
 * Parse only the known nonposting evaluator shape. Unknown versions, non-finite money, or an
 * altered posting flag return null so the UI never treats arbitrary JSON as trusted observations.
 */
export function parseMedicaidEraSummary(value: unknown): PresentedSummary | null {
  const root = record(value);
  if (!root || !Array.isArray(root.claims) || root.claims.length > 100) return null;
  const txCount = root.transactionSetCount;
  if (!(typeof txCount === "number" && Number.isSafeInteger(txCount) && txCount >= 0)) return null;

  const claims: PresentedClaimObservation[] = [];
  for (const raw of root.claims) {
    const item = record(raw);
    const decision = string(item?.decision);
    const reasonCode = string(item?.reasonCode);
    const matchStatus = string(item?.matchStatus);
    const amountsSource = record(item?.amounts);
    if (
      !item ||
      !decision ||
      !DECISIONS.has(decision) ||
      !reasonCode ||
      !matchStatus ||
      item.postingAuthorized !== false ||
      !amountsSource
    )
      return null;

    const amounts: Record<string, number | null> = {};
    for (const key of AMOUNT_KEYS) {
      const amount = cents(amountsSource[key]);
      if (amount === undefined) return null;
      amounts[key] = amount;
    }

    const matched = record(item.matchedClaim);
    const matchedClaimId =
      matchStatus === "MATCHED" &&
      typeof matched?.claimId === "string" &&
      UUID.test(matched.claimId) &&
      typeof matched.submissionId === "string" &&
      UUID.test(matched.submissionId)
        ? matched.claimId
        : null;
    const claimVersion =
      matchedClaimId &&
      typeof matched?.claimVersion === "number" &&
      Number.isSafeInteger(matched.claimVersion)
        ? matched.claimVersion
        : null;
    const providerAdjustments = adjustments(item.providerAdjustments, false, false);
    const claimAdjustments = adjustments(item.claimAdjustments, true, false);
    const serviceLineAdjustments = adjustments(item.serviceLineAdjustments, true, true);
    const unresolved = item.unresolvedRequirements;
    const evidence = item.evidenceReferences;
    if (
      !providerAdjustments ||
      !claimAdjustments ||
      !serviceLineAdjustments ||
      !Array.isArray(unresolved) ||
      !unresolved.every((entry) => typeof entry === "string") ||
      !Array.isArray(evidence) ||
      !evidence.every((entry) => typeof entry === "string")
    )
      return null;

    claims.push({
      decision,
      reasonCode,
      matchStatus,
      matchedClaimId: claimVersion !== null ? matchedClaimId : null,
      claimVersion,
      amounts,
      providerAdjustments,
      claimAdjustments,
      serviceLineAdjustments,
      unresolvedRequirements: unresolved.slice(0, 50),
      evidenceReferenceCount: evidence.length,
    });
  }
  return { transactionSetCount: typeof txCount === "number" ? txCount : null, claims };
}

export const DECISION_LABEL: Readonly<Record<string, string>> = {
  review_required: "Review required",
  payment_reported: "Payment reported — review required",
  unverified: "Historical assessment unverified",
  full_payment_indicated_review_required: "Full payment indicated — review required",
  partial_payment: "Partial payment reported",
  denial: "Denial reported",
  mixed_service_line_outcomes: "Mixed service-line outcomes",
  adjustment_review: "Adjustment requires review",
  reversal_or_recoupment_review: "Reversal or recoupment requires review",
  exact_duplicate: "Exact duplicate held",
  possible_duplicate: "Possible duplicate held",
  source_identity_conflict: "Source identity conflict",
  unmatched_or_ambiguous: "Claim match unresolved",
  inconsistent_financial_totals: "Reported totals are inconsistent",
  provider_adjustment_review: "Provider-level adjustment requires review",
  source_unverified: "Source could not be verified",
};

const REASON_LABELS: Readonly<Record<string, string>> = {
  PAYMENT_REPORTED_REQUIRES_REVIEW: "The payer reported a payment that still requires review.",
  CHARGE_EQUALS_PAYMENT_REVIEW_REQUIRED:
    "Reported charge and payment are equal; review is still required.",
  PARTIAL_PAYMENT_REVIEW: "The payer reported a partial payment.",
  PAYER_REPORTED_DENIAL_STATUS: "The payer reported a denial status.",
  PAYER_REPORTED_REVERSAL_STATUS: "The payer reported a reversal status.",
  REVERSAL_OF_SUPERSEDED_CLAIM_VERSION: "The remittance refers to a superseded claim version.",
  NEGATIVE_PAYMENT_REQUIRES_REVIEW: "A negative payment amount requires review.",
  ZERO_PAYMENT_REQUIRES_STATUS_EVIDENCE:
    "A zero payment requires supporting payer status evidence.",
  SERVICE_LINE_PAID_AND_ZERO_PAYMENT_MIX: "Service lines report different payment outcomes.",
  PROVIDER_LEVEL_ADJUSTMENT_REQUIRES_ALLOCATION_REVIEW:
    "A provider-level adjustment is present and has not been allocated to a claim.",
  PAYER_SPECIFIC_ADJUDICATION_POLICY_UNQUALIFIED:
    "Payer-specific adjudication interpretation has not been qualified.",
  PLB_ALLOCATION_POLICY_REQUIRED: "Provider-level adjustments are not allocated to claims.",
  PAYER_LINE_OUTCOME_POLICY_UNQUALIFIED:
    "Payer service-line interpretation has not been qualified.",
  EXACT_DUPLICATE_HOLD: "This source was classified as an exact duplicate and is held for review.",
  POSSIBLE_DUPLICATE_HOLD: "This source may duplicate an earlier remittance.",
  SOURCE_IDENTITY_CONFLICT_HOLD: "The source identity conflicts with existing evidence.",
  SUBMISSION_UNVERIFIED: "Submission evidence is incomplete.",
  TEST_ERA_CANNOT_MATCH_PRODUCTION_CLAIM:
    "A test remittance cannot be matched to a production claim.",
  CLAIM_CONTROL_MISSING: "The remittance does not include a claim control reference.",
  CLAIM_CONTROL_NOT_FOUND: "No submitted claim matched the available control reference.",
  CLAIM_VERSION_NOT_ACTIVE: "The claim version is no longer active.",
  SOURCE_ACCOUNT_SCOPE_CONFLICT: "The source account does not match the permitted provider scope.",
  SOURCE_ACCOUNT_UNVERIFIED: "The source account could not be verified.",
  REASSESSMENT_SOURCE_UNAVAILABLE:
    "The verified source artifact is no longer available for reassessment.",
  SOURCE_ARTIFACT_UNAVAILABLE:
    "The staged source could not be read for evaluation. It may be outside your authorized scope, or the evaluation service may be unavailable.",
  ERA_PARSE_INVALID: "The staged file could not be read as a valid 835 remittance.",
  ERA_NO_CLAIMS: "The remittance contains no claim-level observations to assess.",
  MULTI_CLAIM_ATTRIBUTION_CONFLICT:
    "The claims in this remittance resolve to different source identities, so one review cannot cover them.",
  ENROLLMENT_NOT_ACTIVE:
    "The source account does not have verified, active enrollment on the date the remittance was received.",
  PAYEE_IDENTITY_CONFLICT:
    "The payee named in the remittance does not match the provider entity's billing identity.",
  PAYEE_TIN_EVIDENCE_UNAVAILABLE:
    "The remittance names a payee tax identifier, but no verified evidence holds one to compare it with.",
  CLAIM_PROVIDER_MISMATCH:
    "A claim with this control number exists, but it belongs to a different provider entity than the source account.",
};

export function reasonExplanation(code: string): string {
  return REASON_LABELS[code] ?? "Additional reason details are unavailable for this assessment.";
}

export function decisionLabel(value: string): string {
  return DECISION_LABEL[value] ?? "Assessment requires review";
}

export const WORKFLOW_LABEL: Readonly<Record<string, string>> = {
  needs_review: "Needs review",
  investigating: "Investigating",
  follow_up_required: "Follow-up required",
  reviewed_not_posted: "Reviewed — not posted",
  reopened: "Reopened",
};

export function workflowLabel(value: string): string {
  return WORKFLOW_LABEL[value] ?? "Workflow status unavailable";
}

export function formatCents(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value)) return "Unavailable";
  const sign = value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  const dollars = Math.floor(absolute / 100);
  const centsPart = String(absolute % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${centsPart}`;
}

export function formatObservedAt(value: string | null): string {
  if (!value) return "Observation time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Observation time unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
