import { describe, expect, it } from "vitest";
import { claimStructureFailure } from "../src/claim-structure";

describe("M24 claim kind and line-family structure", () => {
  it("allows hospice-only only with hospice lines and no R&B arrangement or lines", () => {
    expect(
      claimStructureFailure({
        kind: "hospice_only",
        hasRbArrangement: false,
        hospiceLineCount: 1,
        rbLineCount: 0,
      }),
    ).toBeNull();
    expect(
      claimStructureFailure({
        kind: "hospice_only",
        hasRbArrangement: true,
        hospiceLineCount: 1,
        rbLineCount: 0,
      }),
    ).toBe("rb_arrangement_forbidden");
    expect(
      claimStructureFailure({
        kind: "hospice_only",
        hasRbArrangement: false,
        hospiceLineCount: 1,
        rbLineCount: 1,
      }),
    ).toBe("rb_lines_forbidden");
    expect(
      claimStructureFailure({
        kind: "hospice_only",
        hasRbArrangement: false,
        hospiceLineCount: 0,
        rbLineCount: 0,
      }),
    ).toBe("hospice_lines_required");
  });

  it("requires an arrangement and R&B lines, and forbids hospice lines on R&B-only", () => {
    expect(
      claimStructureFailure({
        kind: "rb_only",
        hasRbArrangement: false,
        hospiceLineCount: 0,
        rbLineCount: 0,
      }),
    ).toBe("rb_arrangement_required");
    expect(
      claimStructureFailure({
        kind: "rb_only",
        hasRbArrangement: true,
        hospiceLineCount: 0,
        rbLineCount: 1,
      }),
    ).toBeNull();
    expect(
      claimStructureFailure({
        kind: "rb_only",
        hasRbArrangement: true,
        hospiceLineCount: 1,
        rbLineCount: 1,
      }),
    ).toBe("hospice_lines_forbidden");
    expect(
      claimStructureFailure({
        kind: "rb_only",
        hasRbArrangement: true,
        hospiceLineCount: 0,
        rbLineCount: 0,
      }),
    ).toBe("rb_lines_required");
  });

  it("requires both line families and an arrangement on combined claims", () => {
    const valid = {
      kind: "combined_hospice_rb" as const,
      hasRbArrangement: true,
      hospiceLineCount: 1,
      rbLineCount: 1,
    };
    expect(claimStructureFailure(valid)).toBeNull();
    expect(claimStructureFailure({ ...valid, hasRbArrangement: false })).toBe(
      "rb_arrangement_required",
    );
    expect(claimStructureFailure({ ...valid, hospiceLineCount: 0 })).toBe("hospice_lines_required");
    expect(claimStructureFailure({ ...valid, rbLineCount: 0 })).toBe("rb_lines_required");
  });
});
