// Migration 1069 renames hipps_* -> per_diem_*, but append-only history (validation_result, segments) is NOT rewritten.
// These aliases are what let a legacy row behave exactly like a current one on the read side.
import { describe, expect, it } from "vitest";
import {
  canonicalFixAction,
  canonicalRemediation,
  canonicalRuleKey,
  canonicalSegments,
  storedRuleKeySpellings,
} from "../src/legacy-stored-aliases";
import { DEFAULT_BILLING_RULES } from "../src/rules";

describe("canonicalRuleKey", () => {
  it("maps the legacy HIPPS rule key onto the registered per-diem class rule", () => {
    expect(canonicalRuleKey("hipps_coding_correct")).toBe("per_diem_class_coding_correct");
    expect(DEFAULT_BILLING_RULES.map((r) => r.key)).toContain(
      canonicalRuleKey("hipps_coding_correct"),
    );
  });

  it("leaves current and unrelated keys untouched, including prototype-chain names", () => {
    expect(canonicalRuleKey("per_diem_class_coding_correct")).toBe("per_diem_class_coding_correct");
    expect(canonicalRuleKey("rule.other")).toBe("rule.other");
    expect(canonicalRuleKey("constructor")).toBe("constructor");
    expect(canonicalRuleKey("__proto__")).toBe("__proto__");
  });
});

describe("storedRuleKeySpellings", () => {
  it("returns the current key and every legacy spelling, whichever one is asked for", () => {
    const expected = ["per_diem_class_coding_correct", "hipps_coding_correct"];
    expect(storedRuleKeySpellings("per_diem_class_coding_correct")).toEqual(expected);
    expect(storedRuleKeySpellings("hipps_coding_correct")).toEqual(expected);
  });

  it("returns just the key when it has no legacy spelling", () => {
    expect(storedRuleKeySpellings("rule.other")).toEqual(["rule.other"]);
  });
});

describe("canonicalFixAction", () => {
  it("maps recompute_hipps and keeps every other action", () => {
    expect(canonicalFixAction("recompute_hipps")).toBe("recompute_per_diem_class");
    expect(canonicalFixAction("recompute_per_diem_class")).toBe("recompute_per_diem_class");
    expect(canonicalFixAction("edit_in_m6")).toBe("edit_in_m6");
  });
});

describe("canonicalRemediation", () => {
  it("maps a flat legacy remediation without mutating the stored value", () => {
    const stored = { summary: "s", fixAction: "recompute_hipps" };
    const out = canonicalRemediation(stored);
    expect(out).toEqual({ summary: "s", fixAction: "recompute_per_diem_class" });
    expect(stored.fixAction).toBe("recompute_hipps");
  });

  it("maps the older nested { remediation: {...} } shape", () => {
    const out = canonicalRemediation({
      remediation: { fixAction: "recompute_hipps" },
      observed: 1,
    });
    expect(out).toEqual({ remediation: { fixAction: "recompute_per_diem_class" }, observed: 1 });
  });

  it("passes non-objects and action-less objects through unchanged", () => {
    expect(canonicalRemediation(null)).toBeNull();
    expect(canonicalRemediation("x")).toBe("x");
    expect(canonicalRemediation({})).toEqual({});
  });
});

describe("canonicalSegments", () => {
  it("renames hippsCharPosition per element, preserving order and other keys", () => {
    const stored = [
      { levelOfCare: "RHC", ratePerDiemCents: 10000, hippsCharPosition: 1 },
      { levelOfCare: "GIP", ratePerDiemCents: 90000, hippsCharPosition: 2 },
    ];
    expect(canonicalSegments(stored)).toEqual([
      { levelOfCare: "RHC", ratePerDiemCents: 10000, perDiemClassCharPosition: 1 },
      { levelOfCare: "GIP", ratePerDiemCents: 90000, perDiemClassCharPosition: 2 },
    ]);
    expect(stored[0]).toHaveProperty("hippsCharPosition", 1);
  });

  it("keeps current-shape segments and non-arrays as they are", () => {
    const current = [{ levelOfCare: "RHC", perDiemClassCharPosition: 1 }];
    expect(canonicalSegments(current)).toEqual(current);
    expect(canonicalSegments(null)).toBeNull();
    expect(canonicalSegments({ a: 1 })).toEqual({ a: 1 });
  });
});
