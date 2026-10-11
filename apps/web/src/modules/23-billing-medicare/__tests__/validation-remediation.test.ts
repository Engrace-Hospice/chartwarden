// Migration 1069 does not rewrite append-only validation_result history, so a legacy `recompute_hipps` fixAction can
// still reach the worklist; the reader maps it onto the current action.
import { describe, expect, it } from "vitest";
import { canonicalFixAction, normalizeRemediation } from "../validation-remediation";

describe("legacy fixAction alias", () => {
  it("maps recompute_hipps to recompute_per_diem_class", () => {
    expect(canonicalFixAction("recompute_hipps")).toBe("recompute_per_diem_class");
  });

  it("keeps current, unknown and absent actions", () => {
    expect(canonicalFixAction("recompute_per_diem_class")).toBe("recompute_per_diem_class");
    expect(canonicalFixAction("edit_in_m6")).toBe("edit_in_m6");
    expect(canonicalFixAction(undefined)).toBeUndefined();
  });

  it("normalizeRemediation canonicalizes a flat and a nested legacy remediation", () => {
    expect(normalizeRemediation({ summary: "s", fixAction: "recompute_hipps" })?.fixAction).toBe(
      "recompute_per_diem_class",
    );
    expect(
      normalizeRemediation({ remediation: { summary: "s", fixAction: "recompute_hipps" } })
        ?.fixAction,
    ).toBe("recompute_per_diem_class");
  });
});
