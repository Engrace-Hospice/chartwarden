/**
 * M25 financial-adjustment policy contract. A source code, taxonomy mapping, or review decision is not
 * authorization to create a financial effect. Only an explicitly approved, effective, exact-scope
 * policy can authorize an action; the current Claim.MD source has no configured policy provider.
 */
export type M25FinancialAction =
  | "provider_write_off"
  | "patient_receivable"
  | "payer_reduction"
  | "provider_recovery"
  | "claim_reversal";

export interface M25FinancialAdjustmentPolicyVersion {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly payerId: string;
  readonly category: "cas" | "plb" | "reversal" | "recoupment";
  readonly reasonCode: string;
  readonly action: M25FinancialAction;
  readonly policyId: string;
  readonly version: number;
  readonly status: "draft" | "approved" | "revoked" | "superseded";
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly requiredPermission: string;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly authorizationSource: string | null;
}

export type M25PolicyResolution =
  | { readonly authorized: false; readonly outcome: "policy_unavailable" }
  | {
      readonly authorized: true;
      readonly outcome: "authorized";
      readonly policyId: string;
      readonly version: number;
      readonly action: M25FinancialAction;
      readonly requiredPermission: string;
    }
  | { readonly authorized: false; readonly outcome: "policy_ambiguous" };

export function resolveM25AdjustmentPolicy(input: {
  readonly policies: readonly M25FinancialAdjustmentPolicyVersion[];
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly payerId: string;
  readonly category: M25FinancialAdjustmentPolicyVersion["category"];
  readonly reasonCode: string;
  readonly at: string;
}): M25PolicyResolution {
  const at = Date.parse(input.at);
  if (!Number.isFinite(at)) return { authorized: false, outcome: "policy_unavailable" };
  const applicable = input.policies.filter((policy) => {
    const from = Date.parse(policy.effectiveFrom);
    const to =
      policy.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(policy.effectiveTo);
    return (
      policy.organizationId === input.organizationId &&
      policy.providerEntityId === input.providerEntityId &&
      policy.payerId === input.payerId &&
      policy.category === input.category &&
      policy.reasonCode === input.reasonCode &&
      policy.status === "approved" &&
      Number.isFinite(from) &&
      (Number.isFinite(to) || to === Number.POSITIVE_INFINITY) &&
      from <= at &&
      at < to &&
      policy.version > 0 &&
      Boolean(policy.approvedBy && policy.approvedAt && policy.authorizationSource)
    );
  });
  if (applicable.length === 0) return { authorized: false, outcome: "policy_unavailable" };
  if (applicable.length !== 1) return { authorized: false, outcome: "policy_ambiguous" };
  const policy = applicable[0]!;
  return {
    authorized: true,
    outcome: "authorized",
    policyId: policy.policyId,
    version: policy.version,
    action: policy.action,
    requiredPermission: policy.requiredPermission,
  };
}

export type ProviderAdjustmentKind =
  | "overpayment_recovery_reported"
  | "forward_balance_reported"
  | "other_provider_adjustment_reported";

/** Only code labels verified in the 005010X221 source are given a category; other codes stay generic. */
export function classifyProviderAdjustmentReason(reason: string): ProviderAdjustmentKind {
  if (reason === "WO") return "overpayment_recovery_reported";
  if (reason === "FB") return "forward_balance_reported";
  return "other_provider_adjustment_reported";
}
