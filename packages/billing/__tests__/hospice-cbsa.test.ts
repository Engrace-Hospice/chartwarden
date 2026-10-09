// @wardenx/billing — the hospice CBSA resolver (value code 61 / G8): ZIP5 -> county -> CBSA / rural 999NN /
// transition 5000N for a federal fiscal year, failing closed on anything it cannot place.
import { type HospiceAreaLookup, claimValueCodes, resolveHospiceArea } from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const COUNTY_BY_ZIP: Record<string, string> = {
  "90210": "06037",
  "58102": "38017",
  "20001": "11001",
};
const AREA_BY_FY_COUNTY: Record<string, ReturnType<HospiceAreaLookup["areaForCounty"]>> = {
  "2026:06037": { cbsaCode: "31084", areaKind: "urban" as const },
  "2026:38017": { cbsaCode: "22020", areaKind: "urban" as const },
  "2025:38017": { cbsaCode: "99935", areaKind: "rural" as const },
  "2026:11001": { cbsaCode: "50002", areaKind: "transition" as const },
};
const lookup: HospiceAreaLookup = {
  countyForZip: (zip5) => COUNTY_BY_ZIP[zip5],
  areaForCounty: (fy, fips) => AREA_BY_FY_COUNTY[`${fy}:${fips}`],
};

describe("resolveHospiceArea", () => {
  it("resolves an urban ZIP to its CBSA", () => {
    expect(resolveHospiceArea("90210", 2026, lookup)).toEqual({
      status: "resolved",
      cbsaCode: "31084",
      areaKind: "urban",
      countyFips: "06037",
    });
  });

  it("uses the fiscal year's own delineation", () => {
    expect(resolveHospiceArea("58102", 2025, lookup)).toMatchObject({
      cbsaCode: "99935",
      areaKind: "rural",
    });
    expect(resolveHospiceArea("58102", 2026, lookup)).toMatchObject({
      cbsaCode: "22020",
      areaKind: "urban",
    });
  });

  it("returns the transition code a transition county reports", () => {
    expect(resolveHospiceArea("20001", 2026, lookup)).toMatchObject({
      cbsaCode: "50002",
      areaKind: "transition",
    });
  });

  it("normalises ZIP+4 to the first five digits", () => {
    expect(resolveHospiceArea("90210-1234", 2026, lookup)).toMatchObject({ status: "resolved" });
  });

  it.each([
    ["", "invalid_zip"],
    ["9021", "invalid_zip"],
    ["ABCDE", "invalid_zip"],
    ["00000", "zip_unknown"],
  ])("fails closed for %j (%s)", (zip, reason) => {
    expect(resolveHospiceArea(zip, 2026, lookup)).toEqual({ status: "unresolved", reason });
  });

  it("fails closed when the county has no area for that fiscal year", () => {
    expect(resolveHospiceArea("90210", 2030, lookup)).toEqual({
      status: "unresolved",
      reason: "county_unknown",
    });
  });
});

describe("claimValueCodes", () => {
  const resolved = {
    status: "resolved",
    cbsaCode: "31084",
    areaKind: "urban",
    countyFips: "06037",
  } as const;
  const facility = {
    status: "resolved",
    cbsaCode: "99935",
    areaKind: "rural",
    countyFips: "38017",
  } as const;
  const unresolved = { status: "unresolved", reason: "zip_unknown" } as const;

  it("reports 61 for home levels and G8 for inpatient levels, once each", () => {
    expect(
      claimValueCodes(["0651", "0652", "0651", "0655"], { residence: resolved, facility }),
    ).toEqual({
      values: [
        { code: "61", cbsaCode: "31084" },
        { code: "G8", cbsaCode: "99935" },
      ],
      missing: [],
    });
  });

  it("ignores revenue codes that need neither (visit lines)", () => {
    expect(claimValueCodes(["0551", "0420"], { residence: null, facility: null })).toEqual({
      values: [],
      missing: [],
    });
  });

  it("lists a required code it cannot resolve, with the reason", () => {
    expect(claimValueCodes(["0651"], { residence: unresolved, facility: null })).toEqual({
      values: [],
      missing: [{ code: "61", reason: "zip_unknown" }],
    });
  });

  it("reports no_source when no ZIP was supplied at all", () => {
    expect(claimValueCodes(["0655"], { residence: null, facility: null })).toEqual({
      values: [],
      missing: [{ code: "G8", reason: "no_zip_recorded" }],
    });
  });
});
