import { describe, expect, it } from "vitest";
import { formatMrn, mrnValue } from "./mrn";

describe("formatMrn", () => {
  it.each([
    ["MRN-E6FBB3B470FD", "MRN E6FBB3B470FD"],
    ["123", "MRN 123"],
    ["mrn 123", "MRN 123"],
    ["MRN: 123", "MRN 123"],
    ["  mrn#123 ", "MRN 123"],
    ["MRNX-1", "MRN MRNX-1"],
  ])("renders %s as %s", (raw, expected) => {
    expect(formatMrn(raw)).toBe(expected);
  });

  it("returns an empty string when there is no value", () => {
    expect(formatMrn(null)).toBe("");
    expect(formatMrn(undefined)).toBe("");
    expect(formatMrn("  ")).toBe("");
    expect(formatMrn("MRN")).toBe("");
  });

  it("mrnValue never double-prefixes", () => {
    expect(mrnValue("MRN-1")).toBe("1");
    expect(mrnValue("1")).toBe("1");
  });
});
