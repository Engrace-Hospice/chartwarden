import { describe, expect, it } from "vitest";
import { validExternalPayerId, validInterval } from "./claimmd-medicare-routing-service";

describe("durable Claim.MD Medicare route validation", () => {
  it("preserves external payer identifiers as strings, including leading zeroes", () => {
    const externalId = "000123";
    expect(validExternalPayerId(externalId)).toBe(true);
    expect(externalId).toBe("000123");
    expect(validExternalPayerId(" payer ")).toBe(false);
    expect(validExternalPayerId("x".repeat(41))).toBe(false);
  });

  it("accepts only real ISO dates and valid inclusive intervals", () => {
    expect(validInterval("2026-01-01", "2026-01-01")).toBe(true);
    expect(validInterval("2026-02-30")).toBe(false);
    expect(validInterval("2026-03-02", "2026-03-01")).toBe(false);
    expect(validInterval("2026-03-01", null)).toBe(true);
  });
});
