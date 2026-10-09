// @wardenx/billing — rule `claim_total_matches_lines` (charges, error, regulatory): the 837I claim charge
// (CLM02) must equal the sum of its service-line charges; the clearinghouse rejects a claim that does not balance.
import { type ValidationContext, claimTotalMatchesLines } from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

const run = (ctx: ValidationContext) =>
  claimTotalMatchesLines.check(ctx, claimTotalMatchesLines.defaultParameters ?? {});

const withLines = (totalChargeCents: number, lineCharges: readonly number[]): ValidationContext => {
  const base = passingContext();
  const template = base.lines[0];
  if (!template) throw new Error("fixture has no line");
  return {
    ...base,
    claim: { ...base.claim, totalChargeCents },
    lines: lineCharges.map((lineChargeCents, i) => ({
      ...template,
      claimLineId: `line-${i + 1}`,
      unitCount: 1,
      unitRateCents: lineChargeCents,
      lineChargeCents,
    })),
  };
};

describe("claim_total_matches_lines", () => {
  it("is a regulatory-required blocking rule", () => {
    expect(claimTotalMatchesLines).toMatchObject({
      key: "claim_total_matches_lines",
      version: 1,
      category: "charges",
      severity: "error",
      regulatoryRequired: true,
      overrideRoleRequired: "billing_manager",
    });
  });

  it("passes when the header total equals the sum of the line charges", () => {
    const r = run(withLines(30_000, [10_000, 20_000]));
    expect(r.passed).toBe(true);
  });

  it("passes for a claim with no charges and no lines", () => {
    expect(run(withLines(0, [])).passed).toBe(true);
  });

  it("fails when the header total exceeds the lines (e.g. an add-on billed in the total only)", () => {
    const r = run(withLines(35_000, [10_000, 20_000]));
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.annotations?.observed).toMatchObject({
      claimTotalCents: 35_000,
      lineSumCents: 30_000,
      differenceCents: 5_000,
    });
    expect(r.annotations?.remediation?.blameTarget).toBe("claim");
  });

  it("fails when the lines exceed the header total", () => {
    const r = run(withLines(10_000, [10_000, 20_000]));
    expect(r.passed).toBe(false);
    expect(r.annotations?.observed).toMatchObject({ differenceCents: -20_000 });
  });
});
