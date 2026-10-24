import { describe, expect, it } from "vitest";
import { denialPayerKind } from "../payer";

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
