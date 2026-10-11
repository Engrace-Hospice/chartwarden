import {
  type RhcCarryOverSnapshot,
  type ValidationContext,
  rhcCarryOverHetsFresh,
} from "@wardenx/billing";
// @wardenx/billing — rule `rhc_carry_over_hets_fresh` (perDiemClass, warn, non-regulatory): a readmission within 60
// days of a prior hospice discharge with a missing / stale (> 30 days) HETS check may have a wrong RHC split.
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

const carry = (over: Partial<RhcCarryOverSnapshot> = {}): RhcCarryOverSnapshot => ({
  priorDays: 21,
  basis: "hets_merged",
  readmittedWithin60Days: true,
  hetsCheckAgeDays: 5,
  warningCodes: [],
  ...over,
});
const run = (rhcCarryOver: RhcCarryOverSnapshot | null | undefined) => {
  const ctx: ValidationContext = { ...passingContext(), rhcCarryOver };
  return rhcCarryOverHetsFresh.check(ctx, rhcCarryOverHetsFresh.defaultParameters ?? {});
};

describe("rhc_carry_over_hets_fresh", () => {
  it("is a non-regulatory warn a billing manager can override", () => {
    expect(rhcCarryOverHetsFresh).toMatchObject({
      key: "rhc_carry_over_hets_fresh",
      version: 1,
      category: "perDiemClass",
      severity: "warn",
      regulatoryRequired: false,
      overrideRoleRequired: "billing_manager",
    });
  });

  it("skips when no carry-over was materialized", () => {
    expect(run(undefined).annotations?.skipReason).toBe("not_applicable");
    expect(run(null).passed).toBe(true);
  });

  it("passes when the stay is not a readmission within 60 days, even with no HETS check", () => {
    const r = run(carry({ readmittedWithin60Days: false, hetsCheckAgeDays: null, priorDays: 0 }));
    expect(r.passed).toBe(true);
  });

  it("passes a readmission with a HETS check from the last 30 days, naming the basis", () => {
    const r = run(carry({ hetsCheckAgeDays: 30 }));
    expect(r.passed).toBe(true);
    expect(r.message).toContain("basis: hets_merged");
  });

  it("warns on a readmission with no HETS check on file", () => {
    const r = run(carry({ basis: "internal_only", hetsCheckAgeDays: null }));
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
    expect(r.message).toMatch(/no HETS eligibility check/);
    expect(r.annotations?.remediation?.fixAction).toBe("refresh_eligibility");
    expect(r.annotations?.observed).toMatchObject({ basis: "internal_only", hetsCheckAgeDays: -1 });
  });

  it("warns on a readmission with a stale (31-day) HETS check", () => {
    const r = run(carry({ basis: "hets_stale", hetsCheckAgeDays: 31 }));
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/31 day\(s\) old/);
  });
});
