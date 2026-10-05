import { describe, expect, it } from "vitest";
import { buildHopeSpecImport } from "../db/import-hope-spec";

describe("HOPE spec importer mapping", () => {
  const built = buildHopeSpecImport();

  it("parses the committed CMS v1.00.1 source package with expected regulatory counts", () => {
    expect(built.items).toHaveLength(194);
    expect(built.options).toHaveLength(554);
    expect(built.iscRows).toBe(776);
    expect(built.activeAssessmentCounts.HA).toEqual({
      A: 56,
      F: 8,
      I: 16,
      J: 43,
      M: 21,
      N: 6,
      Z: 1,
    });
    expect(built.activeAssessmentCounts.HUV).toEqual({ A: 25, J: 22, M: 21, N: 6, Z: 2 });
    expect(built.activeAssessmentCounts.HD).toEqual({ A: 16, Z: 1 });
  });

  it("imports every item with a complete four-row ISC matrix", () => {
    for (const item of built.items) {
      expect(Object.keys(item.isc).sort()).toEqual(["HA", "HD", "HUV", "XX"]);
    }
  });

  it("preserves representative items and official ISC flags", () => {
    const byCode = new Map(built.items.map((item) => [item.itemCode, item]));
    for (const code of [
      "A0050",
      "A0250",
      "J2051A",
      "J2052A",
      "J2053A",
      "M1190",
      "N0500A",
      "N0520A",
    ]) {
      expect(byCode.has(code), code).toBe(true);
    }
    expect(byCode.get("Z0350")?.isc).toEqual({ HA: false, HUV: true, HD: false, XX: true });
    expect(byCode.get("Z0500B")?.isc).toEqual({ HA: true, HUV: true, HD: true, XX: true });
  });

  it("preserves J2051A official coded values as text, including caret reference metadata", () => {
    const options = built.options.filter((option) => option.itemCode === "J2051A");
    expect(options.map((option) => option.valueCode)).toEqual(["0", "1", "^", "2", "3", "9"]);
    expect(
      options
        .filter((option) => option.valueCode !== "^")
        .map((option) => option.valueCode)
        .sort(),
    ).toEqual(["0", "1", "2", "3", "9"]);
    expect(options.find((option) => option.valueCode === "^")?.label).toBe("Blank (skip pattern)");
  });

  it("preserves A0050/A0250 allowed values without implementing runtime record classification", () => {
    const a0050 = built.options
      .filter((option) => option.itemCode === "A0050")
      .map((option) => option.valueCode);
    const a0250 = built.options
      .filter((option) => option.itemCode === "A0250")
      .map((option) => option.valueCode);
    expect(a0050).toEqual(["1", "2", "3"]);
    expect(a0250.sort()).toEqual(["1", "2", "3", "9"]);
  });
});
