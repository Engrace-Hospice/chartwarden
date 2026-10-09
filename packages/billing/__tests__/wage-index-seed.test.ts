// @wardenx/billing — deriving a provider's tenant wage-index entry from the CMS hospice geography.
// Fixture provider: CCN 381588, Pendleton, Oregon (ZIP 97801, Umatilla County 41059).
import { resolveHospiceArea, wageIndexSeedBody } from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const lookup = {
  countyForZip: (zip5: string) => (zip5 === "97801" ? "41059" : undefined),
  areaForCounty: (fy: number, fips: string) =>
    fips === "41059" && fy === 2026
      ? { cbsaCode: "99938", areaKind: "rural" as const, wageIndex: "0.9006" }
      : fips === "41059" && fy === 2025
        ? { cbsaCode: "99938", areaKind: "rural" as const, wageIndex: null }
        : undefined,
};

const seed = (zip: string, fy: number, ccn = "381588") =>
  wageIndexSeedBody({
    ccn,
    providerPostalCode: zip,
    fiscalYearStarting: fy,
    area: resolveHospiceArea(zip, fy, lookup),
  });

describe("wageIndexSeedBody", () => {
  it("derives the entry for CCN 381588 / ZIP 97801 from the resolved area", () => {
    expect(seed("97801", 2026)).toEqual({
      ccn: "381588",
      fiscalYearStarting: 2026,
      cbsaCode: "99938",
      factorDecimal: "0.9006",
      sourceReference:
        "CMS FY2027 hospice wage index, area 99938 (provider ZIP 97801; hospice_cbsa_wage_index)",
    });
  });

  it("refuses a ZIP the geography cannot place — nothing is guessed", () => {
    expect(() => seed("00000", 2026)).toThrow(/could not be placed/);
  });

  it("refuses an area CMS publishes no index for", () => {
    expect(() => seed("97801", 2025)).toThrow(/publishes no wage index/);
  });

  it("refuses a malformed CCN", () => {
    expect(() => seed("97801", 2026, "38158")).toThrow(/not 6 characters/);
  });
});
