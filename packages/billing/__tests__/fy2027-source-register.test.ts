// #713 (S13) - FY2027 rates and wage index reconciled to the CMS source register
// (docs/audits/billing-e2e/FY2027_CMS_SOURCE_REGISTER.md). Each golden value below is pinned to what the repo currently
// carries. No CMS document could be read offline, so every value is "unverified": a failure here means the carried data
// MOVED from the register (a finding to investigate against the CMS table), never that CMS changed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CMS_NATIONAL_RATES_FY2027, type NationalRateSet } from "../src";

/** Dollars as printed in the CMS table (string, so no float arithmetic) -> whole cents. */
const cents = (dollars: string): number => Number(dollars.replace(/[$,.]/g, ""));

interface GoldenRate {
  readonly component: keyof NationalRateSet;
  readonly compliant: string;
  readonly nonCompliant: string;
}

/** CMS-1851-CN corrected Tables (91 FR 61792-61793): FY2027 national hospice per-diem base rates. UNVERIFIED offline. */
const GOLDEN_RATES: readonly GoldenRate[] = [
  { component: "rhcDays1to60PerDiemCents", compliant: "$236.33", nonCompliant: "$227.09" },
  { component: "rhcDays61PlusPerDiemCents", compliant: "$186.33", nonCompliant: "$179.04" },
  { component: "chcPerDiemCents", compliant: "$1,726.16", nonCompliant: "$1,658.66" },
  { component: "chcHourlyRateCents", compliant: "$71.92", nonCompliant: "$69.11" },
  { component: "ircPerDiemCents", compliant: "$545.93", nonCompliant: "$524.58" },
  { component: "gipPerDiemCents", compliant: "$1,231.51", nonCompliant: "$1,183.35" },
];

describe("FY2027 national rate components vs the golden register", () => {
  it.each(GOLDEN_RATES)("$component matches both HQRP columns", (g) => {
    expect(CMS_NATIONAL_RATES_FY2027.hqrpCompliant[g.component]).toBe(cents(g.compliant));
    expect(CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant[g.component]).toBe(cents(g.nonCompliant));
  });

  it("the register lists exactly the components the reference carries", () => {
    expect(GOLDEN_RATES.map((g) => g.component).sort()).toEqual(
      Object.keys(CMS_NATIONAL_RATES_FY2027.hqrpCompliant).sort(),
    );
  });

  it("the module spec's rate table prints the same dollars (second in-repo source)", () => {
    const spec = readFileSync(
      join(__dirname, "../../../docs/modules/CHARTWARDEN_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md"),
      "utf8",
    );
    const section = spec.slice(spec.indexOf("#### FY2027 national rates and HQRP"));
    for (const g of GOLDEN_RATES) {
      expect(section).toContain(g.compliant);
      expect(section).toContain(g.nonCompliant);
    }
  });

  it("internal consistency: non-compliant is compliant x (1.023-0.04)/1.023 within 1 cent, CHC hourly x 24 ~ per diem", () => {
    const c = CMS_NATIONAL_RATES_FY2027.hqrpCompliant;
    const n = CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant;
    for (const key of Object.keys(c) as (keyof NationalRateSet)[]) {
      expect(Math.abs((c[key] * 0.983) / 1.023 - n[key])).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(c.chcHourlyRateCents * 24 - c.chcPerDiemCents)).toBeLessThan(24);
    expect(Math.abs(n.chcHourlyRateCents * 24 - n.chcPerDiemCents)).toBeLessThan(24);
  });
});

// Wage index: the platform table seeded by migration 1058 (generated from the CMS FY2026 / FY2027 hospice wage index
// files). Golden = the seeded value today; the two floor rows are also the CMS correction's published values
// (0.8915 -> 0.8916, 0.8297 -> 0.8298, docs/research/FY2027_HOSPICE_COP_RESEARCH.md section 6). UNVERIFIED offline.
const MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1058_m23_hospice_cbsa_reference.sql"),
  "utf8",
);

function seededIndex(fiscalYearStarting: number, cbsa: string): string | null {
  const re = new RegExp(`^\\(${fiscalYearStarting},'${cbsa}','[^']*',([0-9.]+)\\)`, "m");
  return re.exec(MIGRATION)?.[1] ?? null;
}

const GOLDEN_WAGE_INDEX: readonly {
  readonly cbsa: string;
  readonly area: string;
  readonly fy2026: string;
  readonly fy2027: string;
}[] = [
  { cbsa: "11460", area: "Ann Arbor, MI", fy2026: "0.9869", fy2027: "0.9885" },
  { cbsa: "11694", area: "Arlington-Alexandria-Reston, VA-WV", fy2026: "1.0449", fy2027: "1.0297" },
  { cbsa: "12054", area: "Atlanta-Sandy Springs-Roswell, GA", fy2026: "0.9986", fy2027: "1.0231" },
  { cbsa: "12540", area: "Bakersfield-Delano, CA", fy2026: "1.1840", fy2027: "1.2104" },
  { cbsa: "12580", area: "Baltimore-Columbia-Towson, MD", fy2026: "0.9508", fy2027: "0.9214" },
  { cbsa: "25980", area: "Hinesville, GA2 (FY2027 floor)", fy2026: "0.8894", fy2027: "0.8916" },
  { cbsa: "99935", area: "North Dakota rural (FY2027 floor)", fy2026: "0.8469", fy2027: "0.8298" },
  { cbsa: "99938", area: "Oregon rural", fy2026: "1.0209", fy2027: "1.0285" },
];

describe("wage index golden fixtures (migration 1058) for the FY2026 -> FY2027 boundary", () => {
  it.each(GOLDEN_WAGE_INDEX)("$cbsa $area", (g) => {
    expect(seededIndex(2025, g.cbsa)).toBe(g.fy2026); // fiscal_year_starting 2025 = FY2026
    expect(seededIndex(2026, g.cbsa)).toBe(g.fy2027); // fiscal_year_starting 2026 = FY2027
  });

  it("the corrected FY2027 floor values are the ones seeded (not the superseded 0.8915 / 0.8297)", () => {
    expect(seededIndex(2026, "25980")).toBe("0.8916");
    expect(seededIndex(2026, "99935")).toBe("0.8298");
  });
});
