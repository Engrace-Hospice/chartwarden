import { medicaidCoverageAllowedForClaim } from "@chartwarden/medicaid-adapters";
import { describe, expect, it } from "vitest";

describe("medicaidCoverageAllowedForClaim", () => {
  it("permits combined hospice + R&B with Medicaid in a secondary payer rank", () => {
    expect(medicaidCoverageAllowedForClaim("combined_hospice_rb", 2)).toBe(true);
  });

  it("requires rank 1 Medicaid for a hospice-only claim", () => {
    expect(medicaidCoverageAllowedForClaim("hospice_only", 1)).toBe(true);
    expect(medicaidCoverageAllowedForClaim("hospice_only", 2)).toBe(false);
  });

  it("fails closed for secondary Medicaid on R&B-only pending explicit billing authority", () => {
    expect(medicaidCoverageAllowedForClaim("rb_only", 1)).toBe(true);
    expect(medicaidCoverageAllowedForClaim("rb_only", 2)).toBe(false);
  });
});
