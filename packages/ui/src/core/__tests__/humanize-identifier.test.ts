import { describe, expect, it } from "vitest";
import { humanizeIdentifier } from "../humanize-identifier";

describe("humanizeIdentifier", () => {
  it.each([
    ["m20.safety.coverage_gap_detected", "Safety Coverage Gap Detected"],
    ["m20.field_safety.escalated", "Field Safety Escalated"],
    ["phi.read", "PHI Read"],
    ["routine_visit", "Routine Visit"],
    ["payment-method", "Payment Method"],
  ])("renders %s as %s", (value, expected) => {
    expect(humanizeIdentifier(value)).toBe(expected);
  });

  it("removes a narrative-vocabulary namespace from a display fallback", () => {
    expect(humanizeIdentifier("nv.sp.assessment")).toBe("Spiritual Assessment");
  });
});
