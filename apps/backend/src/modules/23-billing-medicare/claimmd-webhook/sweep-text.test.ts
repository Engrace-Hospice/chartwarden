import { describe, expect, it } from "vitest";
import { vendorCode, vendorText, vendorTime } from "./sweep";

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

describe("vendorCode / vendorTime — vendor strings a tenant receives are code- or time-shaped, never free text", () => {
  it("keeps an id or payer code and drops anything with spaces or punctuation", () => {
    expect(vendorCode("SYN01", 32)).toBe("SYN01");
    expect(vendorCode(77)).toBe("77");
    expect(vendorCode("call Jane at 555")).toBeNull();
    expect(vendorCode("x".repeat(33), 32)).toBeNull();
  });
  it("keeps the two documented Claim.MD timestamp shapes and drops prose", () => {
    expect(vendorTime("2022-09-01 11:34:59am")).toBe("2022-09-01 11:34:59am");
    expect(vendorTime("09-06-2022 13:07")).toBe("09-06-2022 13:07");
    expect(vendorTime("sometime next week")).toBeNull();
  });
});
