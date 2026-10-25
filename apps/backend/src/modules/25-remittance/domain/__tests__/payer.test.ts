import { describe, expect, it } from "vitest";
import { denialPayerKind, resolvePayerKind } from "../payer";

describe("resolvePayerKind (shared by the guard and the read model)", () => {
  const advices = ["medicare", "medicaid", "commercial", null, undefined, "tricare"] as const;
  const bools = [false, true] as const;
  it("advice wins whatever the claim lookups say; otherwise only (M23 miss, M24 hit) is medicaid", () => {
    for (const adviceKind of advices) {
      for (const m23KnowsClaim of bools) {
        for (const m24KnowsClaim of bools) {
          const known =
            adviceKind === "medicare" || adviceKind === "medicaid" || adviceKind === "commercial";
          const expected = known
            ? adviceKind
            : !m23KnowsClaim && m24KnowsClaim
              ? "medicaid"
              : "unknown";
          expect(resolvePayerKind({ adviceKind, m23KnowsClaim, m24KnowsClaim })).toBe(expected);
        }
      }
    }
  });
});

describe("denialPayerKind", () => {
  it.each(["medicare", "medicaid", "commercial"] as const)("advice kind %s wins", (kind) => {
    expect(denialPayerKind({ adviceKind: kind })).toBe(kind);
  });
  it("no advice (277CA / EVV-sourced denial) is unknown, never assumed", () => {
    expect(denialPayerKind({ adviceKind: null })).toBe("unknown");
    expect(denialPayerKind({ adviceKind: undefined })).toBe("unknown");
  });
  it("an unrecognised advice kind is unknown", () => {
    expect(denialPayerKind({ adviceKind: "tricare" })).toBe("unknown");
  });
});
