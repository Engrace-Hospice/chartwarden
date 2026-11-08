import { describe, expect, it } from "vitest";
import { hundredthsText, parseHundredths, parsePriceCents, parseWholeNumber } from "../money";

describe("operator-typed money and counts (string math, no float multiply)", () => {
  it("parses plain dollars to exact cents", () => {
    expect(parsePriceCents("49")).toBe(4900);
    expect(parsePriceCents(" 19.99 ")).toBe(1999);
    expect(parsePriceCents("4.5")).toBe(450);
    expect(parsePriceCents("0.14")).toBe(14);
    expect(parsePriceCents("0")).toBe(0);
  });

  it("refuses what a float multiply or Number() would have taken", () => {
    for (const raw of [
      "1.005",
      "0.145",
      "49.999",
      "1e3",
      "0x1f",
      "0b11",
      "-0.004",
      "-1",
      "+1",
      ".5",
      "5.",
      "",
      "abc",
      "Infinity",
    ]) {
      expect(parsePriceCents(raw), raw).toBeNull();
    }
  });

  it("caps at max and at the safe-integer range", () => {
    expect(parseHundredths("100", 10_000)).toBe(10_000);
    expect(parseHundredths("100.01", 10_000)).toBeNull();
    expect(parsePriceCents("99999999999999999")).toBeNull();
  });

  it("parses whole numbers strictly", () => {
    expect(parseWholeNumber("14")).toBe(14);
    expect(parseWholeNumber("0")).toBe(0);
    for (const raw of ["1e1", "0x10", "1.0", "-1", "", " "])
      expect(parseWholeNumber(raw), raw).toBeNull();
    expect(parseWholeNumber("101", 100)).toBeNull();
  });

  it("prints hundredths back as typed text", () => {
    expect(hundredthsText(4900)).toBe("49");
    expect(hundredthsText(250)).toBe("2.50");
    expect(hundredthsText(5)).toBe("0.05");
    expect(hundredthsText(null)).toBe("");
  });
});
