import { describe, expect, it } from "vitest";
import {
  type M25FinancialAdjustmentPolicyVersion,
  classifyProviderAdjustmentReason,
  resolveM25AdjustmentPolicy,
} from "../adjustment-policy";

const activePolicy: M25FinancialAdjustmentPolicyVersion = {
  organizationId: "org-a",
  providerEntityId: "provider-a",
  payerId: "payer-a",
  category: "plb",
  reasonCode: "WO",
  action: "provider_recovery",
  policyId: "policy-a",
  version: 3,
  status: "approved",
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  requiredPermission: "remittance.recovery.approve",
  createdBy: "finance-admin-a",
  approvedBy: "finance-approver-a",
  approvedAt: "2025-12-20T00:00:00Z",
  authorizationSource: "synthetic-contract-approval",
};

const request = {
  organizationId: "org-a",
  providerEntityId: "provider-a",
  payerId: "payer-a",
  category: "plb" as const,
  reasonCode: "WO",
  at: "2026-11-01T00:00:00Z",
};

describe("M25 financial adjustment policy contract", () => {
  it("fails closed when no effective approved exact-scope policy exists", () => {
    expect(resolveM25AdjustmentPolicy({ ...request, policies: [] })).toEqual({
      authorized: false,
      outcome: "policy_unavailable",
    });
    expect(
      resolveM25AdjustmentPolicy({
        ...request,
        providerEntityId: "provider-b",
        policies: [activePolicy],
      }),
    ).toEqual({ authorized: false, outcome: "policy_unavailable" });
    expect(
      resolveM25AdjustmentPolicy({
        ...request,
        policies: [{ ...activePolicy, status: "draft", approvedBy: null, approvedAt: null }],
      }),
    ).toEqual({ authorized: false, outcome: "policy_unavailable" });
  });

  it("resolves an explicitly approved exact policy version and refuses overlapping active versions", () => {
    expect(resolveM25AdjustmentPolicy({ ...request, policies: [activePolicy] })).toEqual({
      authorized: true,
      outcome: "authorized",
      policyId: "policy-a",
      version: 3,
      action: "provider_recovery",
      requiredPermission: "remittance.recovery.approve",
    });
    expect(
      resolveM25AdjustmentPolicy({
        ...request,
        policies: [activePolicy, { ...activePolicy, policyId: "policy-b" }],
      }),
    ).toEqual({ authorized: false, outcome: "policy_ambiguous" });
  });

  it("only gives documented PLB categories specific labels", () => {
    expect(classifyProviderAdjustmentReason("WO")).toBe("overpayment_recovery_reported");
    expect(classifyProviderAdjustmentReason("FB")).toBe("forward_balance_reported");
    expect(classifyProviderAdjustmentReason("ZZ")).toBe("other_provider_adjustment_reported");
  });
});
