import { describe, expect, it } from "vitest";
import { shouldReevaluateRbDay } from "../src/modules/24-billing-medicaid/jobs/rb-day-lifecycle";
import { RB_EXCLUSION_GIP } from "../src/modules/24-billing-medicaid/jobs/rb-day-sweep";

describe("R&B day lifecycle reevaluation", () => {
  it("re-derives system-managed and unannotated open days", () => {
    expect(shouldReevaluateRbDay({ status: "billable", exclusionReason: null })).toBe(true);
    expect(shouldReevaluateRbDay({ status: "pending", exclusionReason: null })).toBe(true);
    expect(shouldReevaluateRbDay({ status: "excluded", exclusionReason: RB_EXCLUSION_GIP })).toBe(
      true,
    );
  });

  it("preserves operator override evidence by keeping those days out of automatic reevaluation", () => {
    expect(
      shouldReevaluateRbDay({ status: "billable", exclusionReason: "Reviewed by billing manager" }),
    ).toBe(false);
    expect(
      shouldReevaluateRbDay({ status: "excluded", exclusionReason: "Reviewed by billing manager" }),
    ).toBe(false);
  });

  it("does not re-derive excluded days without a recognized system reason", () => {
    expect(shouldReevaluateRbDay({ status: "excluded", exclusionReason: null })).toBe(false);
  });
});
