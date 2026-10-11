// @wardenx/billing — a claim that crosses Oct 1 prices each day with ITS OWN fiscal year's rate table and wage index
// (the federal fiscal year changes the rates on Oct 1), instead of pricing the whole claim at the first day's year.
import {
  type FiscalYearPricing,
  type PerDiemRateTable,
  calculatePerDiemClassByFiscalYear,
  splitAtFiscalYears,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const RATES = (rhc: number): PerDiemRateTable => ({
  rhcDays1to60PerDiemCents: rhc,
  rhcDays61PlusPerDiemCents: rhc,
  chcHourlyRateCents: 6_667,
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
  rhcLaborShare: "0.6600",
  chcLaborShare: "0.6800",
  ircLaborShare: "0.5400",
  gipLaborShare: "0.6400",
});

// FY2026 (starting 2025): $200 RHC, index 1.0; FY2027 (starting 2026): $210 RHC, index 1.1.
const PRICING: Record<number, FiscalYearPricing> = {
  2025: { fiscalYearStarting: 2025, rateTable: RATES(20_000), wageIndexFactorDecimal: "1.0000" },
  2026: { fiscalYearStarting: 2026, rateTable: RATES(21_000), wageIndexFactorDecimal: "1.1000" },
};

const base = {
  hospiceAdmissionDate: "2026-01-01",
  wageIndexCcn: "381588",
  levelOfCarePeriods: [
    { levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-12-31" },
  ] as const,
};

describe("splitAtFiscalYears", () => {
  it("returns one part for a claim inside a fiscal year", () => {
    expect(splitAtFiscalYears("2026-09-01", "2026-09-30")).toEqual([
      { fiscalYearStarting: 2025, from: "2026-09-01", to: "2026-09-30" },
    ]);
  });

  it("splits at Oct 1", () => {
    expect(splitAtFiscalYears("2026-09-29", "2026-10-02")).toEqual([
      { fiscalYearStarting: 2025, from: "2026-09-29", to: "2026-09-30" },
      { fiscalYearStarting: 2026, from: "2026-10-01", to: "2026-10-02" },
    ]);
  });

  it("starts the second part on Oct 1 exactly", () => {
    expect(splitAtFiscalYears("2026-10-01", "2026-10-31")).toEqual([
      { fiscalYearStarting: 2026, from: "2026-10-01", to: "2026-10-31" },
    ]);
  });
});

describe("calculatePerDiemClassByFiscalYear", () => {
  it("prices the September days at FY2026 and the October days at FY2027", () => {
    const result = calculatePerDiemClassByFiscalYear(
      { ...base, claimServiceFrom: "2026-09-29", claimServiceTo: "2026-10-02" },
      (fy) => PRICING[fy] as FiscalYearPricing,
    );
    const [sept, oct] = result.segments;
    expect(sept).toMatchObject({
      dateFrom: "2026-09-29",
      dateTo: "2026-09-30",
      days: 2,
      ratePerDiemCents: 20_000, // 200 × (0.66 × 1.0 + 0.34)
      wageIndexFactorApplied: "1.0000",
      perDiemClassCharPosition: 1,
    });
    expect(oct).toMatchObject({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-02",
      days: 2,
      ratePerDiemCents: 22_386, // 21000 × (0.66 × 1.1 + 0.34)
      wageIndexFactorApplied: "1.1000",
      perDiemClassCharPosition: 2,
    });
    expect(result.totalCents).toBe(2 * 20_000 + 2 * (oct?.ratePerDiemCents ?? 0));
    expect(result.rhcDays1to60 + result.rhcDays61Plus).toBe(4);
  });

  it("is identical to a single calculation when the claim stays inside one fiscal year", () => {
    const one = calculatePerDiemClassByFiscalYear(
      { ...base, claimServiceFrom: "2026-09-01", claimServiceTo: "2026-09-07" },
      (fy) => PRICING[fy] as FiscalYearPricing,
    );
    expect(one.segments).toHaveLength(1);
    expect(one.segments[0]?.ratePerDiemCents).toBe(20_000);
    expect(one.wageIndexFiscalYear).toBe(2025);
  });

  it("keeps the area factors per fiscal year", () => {
    const withAreas: Record<number, FiscalYearPricing> = {
      2025: { ...PRICING[2025], wageIndexAreaFactors: { residence: "0.9000", facility: null } },
      2026: { ...PRICING[2026], wageIndexAreaFactors: { residence: "1.2000", facility: null } },
    } as Record<number, FiscalYearPricing>;
    const result = calculatePerDiemClassByFiscalYear(
      { ...base, claimServiceFrom: "2026-09-30", claimServiceTo: "2026-10-01" },
      (fy) => withAreas[fy] as FiscalYearPricing,
    );
    expect(result.segments.map((s) => s.wageIndexFactorApplied)).toEqual(["0.9000", "1.2000"]);
  });

  it("carries the RHC day-of-stay count across the boundary (days 60 -> 61)", () => {
    const high = {
      ...RATES(20_000),
      rhcDays1to60PerDiemCents: 20_000,
      rhcDays61PlusPerDiemCents: 16_000,
    };
    const result = calculatePerDiemClassByFiscalYear(
      {
        ...base,
        hospiceAdmissionDate: "2026-08-02", // 2026-09-30 is day 60; 2026-10-01 is day 61
        claimServiceFrom: "2026-09-30",
        claimServiceTo: "2026-10-01",
      },
      (fy) => ({
        ...(PRICING[fy] as FiscalYearPricing),
        rateTable: high,
        wageIndexFactorDecimal: "1.0000",
      }),
    );
    expect(result.rhcDays1to60).toBe(1);
    expect(result.rhcDays61Plus).toBe(1);
    expect(result.segments.map((s) => s.ratePerDiemCents)).toEqual([20_000, 16_000]);
  });
});
