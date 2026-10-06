// FY2027 workstream E — the hospice rate screen's pure helpers: dollar parsing and the HQRP-aware comparison.
import { describe, expect, it } from "vitest";
import {
  type NationalRateReference,
  type RateKey,
  centsToDollars,
  centsToInput,
  compareToReference,
  dollarsToCents,
  fiscalYearLabel,
  fiscalYearStartingOf,
  nonCompliantUpdatePct,
} from "../rate-reference";

const REF: NationalRateReference = {
  fiscalYearStarting: 2026,
  fiscalYearLabel: "FY2027",
  paymentUpdatePct: 2.3,
  hqrpReductionPctPoints: 4,
  hqrpCompliant: {
    rhcDays1to60PerDiemCents: 23_633,
    rhcDays61PlusPerDiemCents: 18_633,
    chcPerDiemCents: 172_616,
    chcHourlyRateCents: 7_192,
    ircPerDiemCents: 54_593,
    gipPerDiemCents: 123_151,
  },
  hqrpNonCompliant: {
    rhcDays1to60PerDiemCents: 22_709,
    rhcDays61PlusPerDiemCents: 17_904,
    chcPerDiemCents: 165_866,
    chcHourlyRateCents: 6_911,
    ircPerDiemCents: 52_458,
    gipPerDiemCents: 118_335,
  },
  sources: [{ cite: "CMS-1851-CN, 91 FR 61791", url: "https://example.invalid" }],
  note: "",
};
const set = (v: Partial<Record<RateKey, number | null>>): Record<RateKey, number | null> => ({
  rhcDays1to60PerDiemCents: null,
  rhcDays61PlusPerDiemCents: null,
  chcPerDiemCents: null,
  chcHourlyRateCents: null,
  ircPerDiemCents: null,
  gipPerDiemCents: null,
  ...v,
});

describe("dollars ↔ cents", () => {
  it("parses by string, never by float multiplication", () => {
    expect(dollarsToCents("236.33")).toBe(23_633);
    expect(dollarsToCents("$1,726.16")).toBe(172_616);
    expect(dollarsToCents("71.9")).toBe(7_190);
    expect(dollarsToCents("545")).toBe(54_500);
    expect(dollarsToCents("1.005")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
  });
  it("formats", () => {
    expect(centsToDollars(172_616)).toBe("$1,726.16");
    expect(centsToInput(23_633)).toBe("236.33");
  });
  it("labels fiscal years by their Oct 1 start", () => {
    expect(fiscalYearLabel(2026)).toBe("FY2027");
    expect(fiscalYearStartingOf(new Date(2026, 9, 6))).toBe(2026);
    expect(fiscalYearStartingOf(new Date(2026, 8, 30))).toBe(2025);
  });
});

describe("compareToReference", () => {
  it("no mismatch when the filled fields equal the declared column", () => {
    const c = compareToReference(set(REF.hqrpCompliant), REF, true);
    expect(c.mismatches).toEqual([]);
    expect(c.filled).toBe(6);
  });

  it("names the field, entered and CMS amounts for a typo", () => {
    const c = compareToReference(set({ gipPerDiemCents: 123_115 }), REF, true);
    expect(c.mismatches).toEqual([
      {
        key: "gipPerDiemCents",
        label: "General inpatient",
        enteredCents: 123_115,
        referenceCents: 123_151,
      },
    ]);
    expect(c.matchesOtherColumn).toBe(false);
  });

  it("detects the −4 pp mix-up: rates of the other column", () => {
    expect(compareToReference(set(REF.hqrpNonCompliant), REF, true).matchesOtherColumn).toBe(true);
    expect(compareToReference(set(REF.hqrpCompliant), REF, false).matchesOtherColumn).toBe(true);
  });

  it("ignores unfilled fields while keying", () => {
    const c = compareToReference(set({ rhcDays1to60PerDiemCents: 23_633 }), REF, true);
    expect(c).toEqual({ mismatches: [], matchesOtherColumn: false, filled: 1 });
  });

  it("rounds the non-compliant update", () => {
    expect(nonCompliantUpdatePct(REF)).toBe(-1.7);
  });
});
