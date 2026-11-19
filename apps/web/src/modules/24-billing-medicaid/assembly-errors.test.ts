import { describe, expect, it } from "vitest";
import { assembleErrorMessage } from "./assembly-errors";

describe("Medicaid assembly error guidance", () => {
  it("gives specific guidance when preview readers are unavailable or payer responsibility is unresolved", () => {
    expect(
      assembleErrorMessage(503, { error: { code: "MEDICAID_COVERAGE_READER_UNBOUND" } }),
    ).toContain("Coverage records are unavailable");
    const responsibilityMessage = assembleErrorMessage(409, {
      error: { code: "MEDICAID_PAYER_RESPONSIBILITY_UNRESOLVED" },
    });
    expect(responsibilityMessage).toContain("Payer responsibility could not be established");
    expect(responsibilityMessage).toContain("do not change payer ranking");
    expect(
      assembleErrorMessage(503, { error: { code: "MEDICAID_LOC_PERIOD_READER_UNBOUND" } }),
    ).toContain("level-of-care records are unavailable");
  });

  it("explains the unverified secondary R&B format without denying eligibility", () => {
    expect(
      assembleErrorMessage(409, {
        error: { code: "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED", message: "ignored" },
      }),
    ).toContain("Medicaid eligibility is not denied");
  });

  it("does not label payer-responsibility conflicts as duplicate claims", () => {
    expect(
      assembleErrorMessage(409, { error: { code: "MEDICAID_TPL_POLICY_UNVERIFIED" } }),
    ).toContain("third-party-liability policy");
  });

  it("gives actionable guidance for an occupied R&B day and unverified Medicare linkage", () => {
    expect(
      assembleErrorMessage(409, { error: { code: "MEDICAID_RB_DAYS_ALREADY_ASSIGNED" } }),
    ).toContain("already belong to a claim");
    expect(
      assembleErrorMessage(409, { error: { code: "MEDICAID_MEDICARE_LINKAGE_UNSUPPORTED" } }),
    ).toContain("not adjudication or payment evidence");
  });

  it("does not describe an awaiting discharge as a confirmed stay end", () => {
    expect(
      assembleErrorMessage(409, { error: { code: "MEDICAID_RB_ADMISSION_END_PENDING" } }),
    ).toContain("awaiting required approval");
  });

  it("matches the arrangement guidance to the identifier field in the assembly wizard", () => {
    expect(assembleErrorMessage(409, { error: { code: "MEDICAID_RB_ARRANGEMENT_REQUIRED" } })).toBe(
      "Enter an applicable Room & Board arrangement ID before assembling this claim kind.",
    );
  });

  it("uses a conservative generic conflict message for unknown 409 codes", () => {
    expect(
      assembleErrorMessage(409, { error: { code: "UNKNOWN", message: "sensitive detail" } }),
    ).toBe(
      "Coverage, claim state, or another assembly condition conflicts with this request. Review the current records before continuing.",
    );
  });

  it("never displays arbitrary server error details", () => {
    expect(
      assembleErrorMessage(500, { error: { code: "INTERNAL_ERROR", message: "database text" } }),
    ).toBe("The claim could not be assembled.");
  });
});
