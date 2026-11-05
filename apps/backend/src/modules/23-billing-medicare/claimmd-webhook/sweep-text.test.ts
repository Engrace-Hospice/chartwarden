import { describe, expect, it } from "vitest";
import { vendorText } from "./sweep";

describe("vendorText — a Claim.MD element value bound for an outbox payload", () => {
  it("keeps a bounded, printable value (trimmed) and a safe integer", () => {
    expect(vendorText(" ENR-1\n")).toBe("ENR-1");
    expect(vendorText(1234567890, 10)).toBe("1234567890");
  });
  it("drops control characters, NUL included, so one bad value cannot poison the row's write", () => {
    expect(vendorText("ENR\u00001")).toBeNull();
    expect(vendorText("a\nb")).toBeNull();
  });
  it("drops blank, over-long and non-scalar values", () => {
    expect(vendorText("   ")).toBeNull();
    expect(vendorText("x".repeat(65))).toBeNull();
    expect(vendorText({})).toBeNull();
  });
});
