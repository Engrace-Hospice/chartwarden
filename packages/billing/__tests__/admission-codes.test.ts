// @wardenx/billing — the claim's UB-04 Type of Admission (FL 14 / CL101) and Point of Origin (FL 15 / CL102): the
// snapshot taken from the admission and the `admission_codes_present` rule that blocks a claim without them.
import {
  type ValidationContext,
  admissionCodesPresent,
  claimAdmissionCodes,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

describe("claimAdmissionCodes", () => {
  it("passes recorded codes through", () => {
    expect(claimAdmissionCodes({ admissionTypeCode: "3", admissionSourceCode: "1" })).toEqual({
      admissionTypeCode: "3",
      admissionSourceCode: "1",
    });
  });

  it("is null for unrecorded codes, never an invented default", () => {
    expect(claimAdmissionCodes({})).toEqual({ admissionTypeCode: null, admissionSourceCode: null });
    expect(claimAdmissionCodes({ admissionTypeCode: null, admissionSourceCode: null })).toEqual({
      admissionTypeCode: null,
      admissionSourceCode: null,
    });
  });

  it("drops a value outside the NUBC set instead of passing it to a federal claim", () => {
    expect(claimAdmissionCodes({ admissionTypeCode: "4", admissionSourceCode: "7" })).toEqual({
      admissionTypeCode: null,
      admissionSourceCode: null,
    });
  });
});

const run = (claim: Partial<ValidationContext["claim"]>) => {
  const base = passingContext();
  const ctx: ValidationContext = { ...base, claim: { ...base.claim, ...claim } };
  return admissionCodesPresent.check(ctx, {});
};

describe("admission_codes_present", () => {
  it("is a blocking, regulatory-required rule", () => {
    expect(admissionCodesPresent).toMatchObject({
      key: "admission_codes_present",
      version: 1,
      category: "admission",
      severity: "error",
      regulatoryRequired: true,
      overrideRoleRequired: "billing_manager",
    });
  });

  it("passes when both codes are recorded", () => {
    expect(run({ admissionTypeCode: "3", admissionSourceCode: "1" }).passed).toBe(true);
  });

  it("skips (not applicable) when the context carries no admission-code facts", () => {
    const r = run({ admissionTypeCode: undefined, admissionSourceCode: undefined });
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("not_applicable");
  });

  it.each([
    ["type", { admissionTypeCode: null, admissionSourceCode: "1" }, ["ADMISSION_TYPE_MISSING"]],
    [
      "point of origin",
      { admissionTypeCode: "3", admissionSourceCode: null },
      ["ADMISSION_SOURCE_MISSING"],
    ],
    [
      "both",
      { admissionTypeCode: null, admissionSourceCode: null },
      ["ADMISSION_TYPE_MISSING", "ADMISSION_SOURCE_MISSING"],
    ],
  ])("fails when the %s is not recorded", (_name, claim, expectedCodes) => {
    const r = run(claim);
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.annotations?.remediation?.fixAction).toBe("record_admission_codes_in_m6");
    expect((r.annotations?.defects ?? []).map((d) => d.code)).toEqual(expectedCodes);
  });
});
