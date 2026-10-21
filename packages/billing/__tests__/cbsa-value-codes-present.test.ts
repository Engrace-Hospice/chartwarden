// @chartwarden/billing — §4.5 rule `cbsa_value_codes_present`: a claim with home-level lines must carry value code 61 and
// one with inpatient lines G8; one whose area cannot be resolved is blocked, naming the code and why (no address).
import { type ValidationContext, cbsaValueCodesPresent } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

const run = (valueCodes: ValidationContext["claim"]["valueCodes"]) => {
  const base = passingContext();
  const ctx: ValidationContext = { ...base, claim: { ...base.claim, valueCodes } };
  return cbsaValueCodesPresent.check(ctx, {});
};

describe("cbsa_value_codes_present", () => {
  it("is a blocking, regulatory-required rule", () => {
    expect(cbsaValueCodesPresent).toMatchObject({
      key: "cbsa_value_codes_present",
      category: "wage",
      severity: "error",
      regulatoryRequired: true,
    });
  });

  it("skips when the context carries no value-code resolution", () => {
    const r = run(undefined);
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("not_applicable");
  });

  it("passes when every required code is resolved (or none is required)", () => {
    expect(run({ values: [{ code: "61", cbsaCode: "31084" }], missing: [] }).passed).toBe(true);
    expect(run({ values: [], missing: [] }).passed).toBe(true);
  });

  it("fails naming each unresolved code and its reason", () => {
    const r = run({
      values: [],
      missing: [
        { code: "61", reason: "zip_unknown" },
        { code: "G8", reason: "no_zip_recorded" },
      ],
    });
    expect(r.passed).toBe(false);
    expect((r.annotations?.defects ?? []).map((d) => d.code)).toEqual([
      "VALUE_CODE_61_UNRESOLVED",
      "VALUE_CODE_G8_UNRESOLVED",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/\d{5}-?\d{0,4}\b.*zip/i);
  });
});
