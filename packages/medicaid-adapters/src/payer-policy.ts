import type { MedicaidClaimKind } from "./contracts";

export interface MedicaidPayerResponsibilityInput {
  readonly claimKind: MedicaidClaimKind;
  readonly medicaidCoverageId: string;
  readonly medicaidRank: number;
  readonly primaryCoverageId: string;
  readonly primaryCoverageKind: string;
  readonly primaryRank: number;
}

export type MedicaidPayerResponsibilityRefusal =
  | "rank_one_coverage_missing"
  | "tertiary_medicaid_unsupported"
  | "coverage_identity_conflict"
  | "medicare_hospice_is_primary"
  | "medicare_secondary_rb_format_unconfirmed"
  | "medicare_secondary_combined_format_unconfirmed"
  | "third_party_liability_policy_unconfirmed";

export type MedicaidPayerResponsibilityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: MedicaidPayerResponsibilityRefusal };

/**
 * Interim assembly policy. Coverage rank alone does not establish responsibility: callers must provide the actual
 * rank-1 coverage resolved across all coverage kinds for the complete service window. Until the state-specific
 * secondary Medicaid claim format and COB treatment are confirmed, only an unambiguous rank-1 Medicaid row is
 * permitted by this payer-responsibility gate. This is not a determination that secondary Medicaid is ineligible.
 */
export function evaluateMedicaidPayerResponsibility(
  input: MedicaidPayerResponsibilityInput,
): MedicaidPayerResponsibilityDecision {
  if (input.primaryRank !== 1) return { allowed: false, reason: "rank_one_coverage_missing" };

  if (input.medicaidRank >= 3) {
    return { allowed: false, reason: "tertiary_medicaid_unsupported" };
  }

  if (input.primaryCoverageKind === "medicaid") {
    return input.medicaidRank === 1 && input.medicaidCoverageId === input.primaryCoverageId
      ? { allowed: true }
      : { allowed: false, reason: "coverage_identity_conflict" };
  }

  if (input.medicaidRank === 1) {
    return { allowed: false, reason: "coverage_identity_conflict" };
  }

  if (input.primaryCoverageKind === "medicare_ffs") {
    switch (input.claimKind) {
      case "hospice_only":
        return { allowed: false, reason: "medicare_hospice_is_primary" };
      case "rb_only":
        return { allowed: false, reason: "medicare_secondary_rb_format_unconfirmed" };
      case "combined_hospice_rb":
        return { allowed: false, reason: "medicare_secondary_combined_format_unconfirmed" };
    }
  }

  return { allowed: false, reason: "third_party_liability_policy_unconfirmed" };
}
