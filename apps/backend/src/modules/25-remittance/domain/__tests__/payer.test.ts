import { describe, expect, it } from "vitest";
import { denialPayerKind } from "../payer";

describe("denialPayerKind", () => {
  it.each(["medicare", "medicaid", "commercial"] as const)("advice kind %s wins", (kind) => {
    expect(denialPayerKind({ adviceKind: kind, source: "remittance_adjustment" })).toBe(kind);
  });
  it.each(["claim_rejection_277ca", "evv_aggregator_rejection"])(
    "no advice on a %s denial is unknown, never assumed",
    (source) => {
      expect(denialPayerKind({ adviceKind: null, source })).toBe("unknown");
      expect(denialPayerKind({ adviceKind: undefined, source })).toBe("unknown");
    },
  );
  it("an unrecognised advice kind is unknown", () => {
    expect(denialPayerKind({ adviceKind: "tricare" })).toBe("unknown");
  });
  it("source does not override the advice kind", () => {
    expect(denialPayerKind({ adviceKind: "medicaid", source: "claim_rejection_277ca" })).toBe(
      "medicaid",
    );
  });
});
