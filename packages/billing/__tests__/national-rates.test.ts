// FY2027 workstream E — the CMS national per-diem REFERENCE and the HQRP-aware sanity check.
import { describe, expect, it } from "vitest";
import {
  CMS_NATIONAL_RATES_FY2027,
  type NationalRateSet,
  checkRatesAgainstNationalReference,
  nationalRateReferenceFor,
  validateRateTableEntry,
} from "../src";

const FY2027 = 2026; // fiscal_year_starting
const compliant = CMS_NATIONAL_RATES_FY2027.hqrpCompliant;
const nonCompliant = CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant;
const entry = (rates: NationalRateSet) => ({ ...rates, fiscalYearStarting: FY2027 });

describe("CMS national rate reference (FY2027, corrected per CMS-1851-CN)", () => {
  it("carries the CORRECTED national rates, not the superseded final-rule Tables 1-4", () => {
    expect(compliant).toEqual({
      rhcDays1to60PerDiemCents: 23_633,
      rhcDays61PlusPerDiemCents: 18_633,
      chcPerDiemCents: 172_616,
      chcHourlyRateCents: 7_192,
      ircPerDiemCents: 54_593,
      gipPerDiemCents: 123_151,
    });
    expect(nonCompliant).toEqual({
      rhcDays1to60PerDiemCents: 22_709,
      rhcDays61PlusPerDiemCents: 17_904,
      chcPerDiemCents: 165_866,
      chcHourlyRateCents: 6_911,
      ircPerDiemCents: 52_458,
      gipPerDiemCents: 118_335,
    });
    expect(CMS_NATIONAL_RATES_FY2027.paymentUpdatePct).toBe(2.3);
    expect(CMS_NATIONAL_RATES_FY2027.hqrpReductionPctPoints).toBe(4);
    expect(CMS_NATIONAL_RATES_FY2027.sources.map((s) => s.cite).join(" ")).toContain("91 FR 61791");
  });

  it("is keyed by fiscal_year_starting (2026 = FY2027) and returns null for a year with no confirmed reference", () => {
    expect(nationalRateReferenceFor(2026)?.fiscalYearLabel).toBe("FY2027");
    expect(nationalRateReferenceFor(2025)).toBeNull();
  });

  it("both reference columns pass the keyed-entry validator (CHC hourly × 24 agrees with the per diem)", () => {
    for (const rates of [compliant, nonCompliant]) {
      const v = validateRateTableEntry({
        ...entry(rates),
        effectiveFrom: "2026-10-01",
        laborShareRhc: "0.6600",
        laborShareChc: "0.6600",
        laborShareIrc: "0.5400",
        laborShareGip: "0.6400",
      });
      expect(v.ok).toBe(true);
    }
  });
});

describe("checkRatesAgainstNationalReference", () => {
  it("no warning when the rates match the declared HQRP column", () => {
    expect(checkRatesAgainstNationalReference(entry(compliant), true)).toEqual([]);
    expect(checkRatesAgainstNationalReference(entry(nonCompliant), false)).toEqual([]);
  });

  it("one pointed warning when the rates are the OTHER column (the -4 pp mix-up, both ways)", () => {
    const declaredCompliant = checkRatesAgainstNationalReference(entry(nonCompliant), true);
    expect(declaredCompliant).toHaveLength(1);
    expect(declaredCompliant[0]).toMatch(/NON-compliant national rates \(-1\.7% update\)/);
    const declaredNon = checkRatesAgainstNationalReference(entry(compliant), false);
    expect(declaredNon).toHaveLength(1);
    expect(declaredNon[0]).toMatch(/compliant national rates \(\+2\.3%\)/);
  });

  it("lists every mismatched field with entered vs CMS amounts", () => {
    const typo = { ...compliant, gipPerDiemCents: 123_115, ircPerDiemCents: 54_598 };
    const w = checkRatesAgainstNationalReference(entry(typo), true);
    expect(w[0]).toMatch(/differ from the FY2027 HQRP-compliant national rates/);
    expect(w).toContain("GIP: entered $1231.15, CMS national $1231.51");
    expect(w).toContain("IRC: entered $545.98, CMS national $545.93");
    expect(w).toHaveLength(3);
  });

  it("flags the superseded (uncorrected) final-rule rates as a mismatch", () => {
    const superseded = {
      ...compliant,
      rhcDays1to60PerDiemCents: 23_635,
      rhcDays61PlusPerDiemCents: 18_635,
    };
    expect(checkRatesAgainstNationalReference(entry(superseded), true).length).toBeGreaterThan(0);
  });

  it("an undeclared status asks for the declaration and names the column the rates match", () => {
    expect(checkRatesAgainstNationalReference(entry(compliant), null)[0]).toMatch(
      /not declared; the rates match the FY2027 HQRP-compliant/,
    );
    expect(checkRatesAgainstNationalReference(entry(nonCompliant), undefined)[0]).toMatch(
      /not declared; the rates match the FY2027 HQRP NON-compliant/,
    );
    const neither = checkRatesAgainstNationalReference(
      entry({ ...compliant, gipPerDiemCents: 1 }),
      null,
    );
    expect(neither[0]).toMatch(/match neither/);
  });

  it("no reference on file for the year ⇒ no warnings (never invents a rate)", () => {
    expect(
      checkRatesAgainstNationalReference({ ...compliant, fiscalYearStarting: 2025 }, true),
    ).toEqual([]);
  });
});
