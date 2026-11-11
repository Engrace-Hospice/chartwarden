// The operator's written reason, judged the way the server judges it. The server stores a reason in the tenant-visible audit trail,
// so it collapses whitespace and removes control and format characters BEFORE it counts (a reason of "abcd    " is a 422, not a row).
// The form must count the same way, or it lets through what the server refuses and refuses what the server accepts.
import { describe, expect, it } from "vitest";
import { REASON_RULES, checkReason, normalizeReason } from "../reason";

describe("normalizeReason", () => {
  it("collapses whitespace runs (line breaks and tabs included) to one space and trims", () => {
    expect(normalizeReason("  line one\n\n line\ttwo  ")).toBe("line one line two");
  });

  it("removes control and format characters (zero-width, bidi override) without fusing words", () => {
    expect(normalizeReason("ticket\u200b CHG-4521\u202e")).toBe("ticket CHG-4521");
    expect(normalizeReason("a\nb")).toBe("a b");
  });
});

describe("checkReason", () => {
  const rule = REASON_RULES.decision;

  it("accepts a reason at the lower and upper bound", () => {
    expect(checkReason("12345678", rule)).toBeNull();
    expect(checkReason("x".repeat(rule.max), rule)).toBeNull();
  });

  it("counts the NORMALISED length: padding does not make a short reason long enough", () => {
    expect(checkReason("abcd      ", rule)).toMatch(/at least 8/);
    expect(checkReason("ab\u200b\u200b\u200b cd", rule)).toMatch(/at least 8/);
  });

  it("refuses an empty reason and one over the maximum, naming the bound", () => {
    expect(checkReason("", rule)).toMatch(/at least 8/);
    expect(checkReason("x".repeat(rule.max + 1), rule)).toMatch(/at most 1000/);
  });

  it("carries the bound of each kind of action", () => {
    expect(REASON_RULES.decision).toEqual({ min: 8, max: 1000 });
    expect(REASON_RULES.officer).toEqual({ min: 8, max: 500 });
    expect(REASON_RULES.onboardingData).toEqual({ min: 8, max: 500 });
    expect(REASON_RULES.skip).toEqual({ min: 8, max: 2000 });
    // M35's pricing reasons are judged by its own normalizeReason: 8 to 500 characters.
    expect(REASON_RULES.pricing).toEqual({ min: 8, max: 500 });
  });
});
