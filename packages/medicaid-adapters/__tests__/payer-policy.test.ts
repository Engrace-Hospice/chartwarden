import { evaluateMedicaidPayerResponsibility } from "@chartwarden/medicaid-adapters";
import { describe, expect, it } from "vitest";

const primaryMedicaid = {
  claimKind: "hospice_only" as const,
  medicaidCoverageId: "medicaid-primary",
  medicaidRank: 1,
  primaryCoverageId: "medicaid-primary",
  primaryCoverageKind: "medicaid",
  primaryRank: 1,
};

describe("evaluateMedicaidPayerResponsibility", () => {
  it.each(["hospice_only", "rb_only", "combined_hospice_rb"] as const)(
    "permits %s when Medicaid is the unambiguous rank-1 coverage",
    (claimKind) => {
      expect(evaluateMedicaidPayerResponsibility({ ...primaryMedicaid, claimKind })).toEqual({
        allowed: true,
      });
    },
  );

  it.each([
    ["hospice_only", "medicare_hospice_is_primary"],
    ["rb_only", "medicare_secondary_rb_format_unconfirmed"],
    ["combined_hospice_rb", "medicare_secondary_combined_format_unconfirmed"],
  ] as const)(
    "classifies secondary Medicaid %s for a Medicare-primary patient",
    (claimKind, reason) => {
      expect(
        evaluateMedicaidPayerResponsibility({
          ...primaryMedicaid,
          claimKind,
          medicaidCoverageId: "medicaid-secondary",
          medicaidRank: 2,
          primaryCoverageId: "medicare-primary",
          primaryCoverageKind: "medicare_ffs",
          primaryRank: 1,
        }),
      ).toEqual({ allowed: false, reason });
    },
  );

  it("does not equate a top-ranked row at rank 2 with primary coverage", () => {
    expect(
      evaluateMedicaidPayerResponsibility({
        ...primaryMedicaid,
        medicaidRank: 2,
        primaryRank: 2,
      }),
    ).toEqual({ allowed: false, reason: "rank_one_coverage_missing" });
  });

  it("does not apply the Medicare exception to commercial primary coverage", () => {
    expect(
      evaluateMedicaidPayerResponsibility({
        ...primaryMedicaid,
        medicaidCoverageId: "medicaid-secondary",
        medicaidRank: 2,
        primaryCoverageId: "commercial-primary",
        primaryCoverageKind: "commercial",
        primaryRank: 1,
      }),
    ).toEqual({ allowed: false, reason: "third_party_liability_policy_unconfirmed" });
  });

  it("does not treat tertiary Medicaid as the Medicare-secondary case", () => {
    expect(
      evaluateMedicaidPayerResponsibility({
        ...primaryMedicaid,
        medicaidCoverageId: "medicaid-tertiary",
        medicaidRank: 3,
        primaryCoverageId: "medicare-primary",
        primaryCoverageKind: "medicare_ffs",
        primaryRank: 1,
      }),
    ).toEqual({ allowed: false, reason: "tertiary_medicaid_unsupported" });
  });

  it("fails closed when the rank-1 and selected Medicaid identities conflict", () => {
    expect(
      evaluateMedicaidPayerResponsibility({
        ...primaryMedicaid,
        primaryCoverageId: "other-medicaid-row",
      }),
    ).toEqual({ allowed: false, reason: "coverage_identity_conflict" });
  });
});
