import { describe, expect, it } from "vitest";
import { assembleErrorMessage } from "./assembly-errors";

describe("Medicaid assembly error guidance", () => {
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
