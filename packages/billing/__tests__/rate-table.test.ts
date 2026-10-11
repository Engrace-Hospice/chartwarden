// F-210 — the tenant-entered hospice rate table's PURE rules: validation, fiscal-year window, overlap, coverage.
import { describe, expect, it } from "vitest";
import {
  type RateTableEntry,
  dateRangesOverlap,
  fiscalYearWindow,
  hasLaborShares,
  hospiceFiscalYearStartingOf,
  toPerDiemRateTable,
  validateRateTableEntry,
  windowCovers,
} from "../src";

const GOOD: RateTableEntry = {
  fiscalYearStarting: 2025,
  effectiveFrom: "2025-10-01",
  rhcDays1to60PerDiemCents: 21_500,
  rhcDays61PlusPerDiemCents: 17_000,
  chcPerDiemCents: 105_600,
  ircPerDiemCents: 49_000,
  gipPerDiemCents: 118_000,
  chcHourlyRateCents: 4_400,
  laborShareRhc: "0.6600",
  laborShareChc: "0.6800",
  laborShareIrc: "0.5400",
  laborShareGip: "0.6400",
};

describe("validateRateTableEntry", () => {
  it("accepts a well-formed entry and defaults effectiveTo to the fiscal-year end", () => {
    expect(validateRateTableEntry(GOOD)).toEqual({ ok: true, effectiveTo: "2026-09-30" });
  });

  it("keeps an explicit in-year effectiveTo", () => {
    expect(validateRateTableEntry({ ...GOOD, effectiveTo: "2026-03-31" })).toEqual({
      ok: true,
      effectiveTo: "2026-03-31",
    });
  });

  it("rejects dollars keyed as cents (a $215.00 per-diem typed 215)", () => {
    const r = validateRateTableEntry({ ...GOOD, rhcDays1to60PerDiemCents: 215 });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.join(" ")).toMatch(/rhcDays1to60PerDiemCents.*plausible band.*WHOLE CENTS/);
  });

  it.each([0, -5, 1.5, Number.NaN])(
    "rejects a non-positive / non-integer cents value %s",
    (bad) => {
      expect(validateRateTableEntry({ ...GOOD, gipPerDiemCents: bad }).ok).toBe(false);
      expect(validateRateTableEntry({ ...GOOD, chcHourlyRateCents: bad }).ok).toBe(false);
    },
  );

  it("rejects RHC day 1-60 below day 61+ (ADR-0001 tier order)", () => {
    const r = validateRateTableEntry({
      ...GOOD,
      rhcDays1to60PerDiemCents: 16_000,
      rhcDays61PlusPerDiemCents: 17_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/ADR-0001/);
  });

  it("rejects a CHC hourly rate that disagrees with the 24-hour per-diem", () => {
    const r = validateRateTableEntry({ ...GOOD, chcHourlyRateCents: 5_400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/x 24.*must agree/);
  });

  it("tolerates whole-cent rounding of the hourly rate (24 cents)", () => {
    expect(validateRateTableEntry({ ...GOOD, chcPerDiemCents: 105_610 }).ok).toBe(true);
    expect(validateRateTableEntry({ ...GOOD, chcPerDiemCents: 105_625 }).ok).toBe(false);
  });

  it("rejects a window outside the stated fiscal year", () => {
    expect(validateRateTableEntry({ ...GOOD, effectiveFrom: "2025-09-30" }).ok).toBe(false);
    expect(validateRateTableEntry({ ...GOOD, effectiveTo: "2026-10-01" }).ok).toBe(false);
  });

  it("rejects effectiveTo before effectiveFrom, and malformed dates", () => {
    expect(
      validateRateTableEntry({ ...GOOD, effectiveFrom: "2026-01-10", effectiveTo: "2026-01-09" })
        .ok,
    ).toBe(false);
    expect(validateRateTableEntry({ ...GOOD, effectiveFrom: "2025-02-30" }).ok).toBe(false);
  });

  it("collects every error, not just the first", () => {
    const r = validateRateTableEntry({ ...GOOD, ircPerDiemCents: 5, gipPerDiemCents: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fiscal-year helpers", () => {
  it("maps Oct-Dec to the year it starts in and Jan-Sep to the previous year", () => {
    expect(hospiceFiscalYearStartingOf("2025-10-01")).toBe(2025);
    expect(hospiceFiscalYearStartingOf("2026-09-30")).toBe(2025);
    expect(hospiceFiscalYearStartingOf("2026-01-15")).toBe(2025);
    expect(hospiceFiscalYearStartingOf("2026-10-01")).toBe(2026);
  });
  it("returns the Oct 1 - Sep 30 window", () => {
    expect(fiscalYearWindow(2025)).toEqual({ from: "2025-10-01", to: "2026-09-30" });
  });
});

describe("dateRangesOverlap / windowCovers", () => {
  it("treats ranges as inclusive on both ends", () => {
    expect(
      dateRangesOverlap(
        { from: "2025-10-01", to: "2026-03-31" },
        { from: "2026-03-31", to: "2026-09-30" },
      ),
    ).toBe(true);
    expect(
      dateRangesOverlap(
        { from: "2025-10-01", to: "2026-03-31" },
        { from: "2026-04-01", to: "2026-09-30" },
      ),
    ).toBe(false);
  });
  it("treats a null end as open-ended", () => {
    expect(
      dateRangesOverlap({ from: "2025-10-01", to: null }, { from: "2030-01-01", to: "2030-02-01" }),
    ).toBe(true);
    expect(
      dateRangesOverlap({ from: "2025-10-01", to: null }, { from: "2020-01-01", to: "2025-09-30" }),
    ).toBe(false);
  });
  it("covers the boundary days and nothing outside", () => {
    const w = { from: "2025-10-01", to: "2026-09-30" };
    expect(windowCovers(w, "2025-10-01")).toBe(true);
    expect(windowCovers(w, "2026-09-30")).toBe(true);
    expect(windowCovers(w, "2025-09-30")).toBe(false);
    expect(windowCovers(w, "2026-10-01")).toBe(false);
    expect(windowCovers({ from: "2025-10-01", to: null }, "2099-01-01")).toBe(true);
  });
});

describe("toPerDiemRateTable", () => {
  it("projects the rates + labor shares the HIPPS calculator injects (CHC as its HOURLY rate)", () => {
    expect(toPerDiemRateTable({ ...GOOD })).toEqual({
      rhcDays1to60PerDiemCents: 21_500,
      rhcDays61PlusPerDiemCents: 17_000,
      chcHourlyRateCents: 4_400,
      ircPerDiemCents: 49_000,
      gipPerDiemCents: 118_000,
      rhcLaborShare: "0.6600",
      chcLaborShare: "0.6800",
      ircLaborShare: "0.5400",
      gipLaborShare: "0.6400",
    });
  });

  it("refuses to project a pre-0280 row with no labor shares (callers fail closed first)", () => {
    const legacy = {
      ...GOOD,
      laborShareRhc: null,
      laborShareChc: null,
      laborShareIrc: null,
      laborShareGip: null,
    };
    expect(hasLaborShares(legacy)).toBe(false);
    expect(() => toPerDiemRateTable(legacy)).toThrow(RangeError);
    expect(hasLaborShares({ ...GOOD })).toBe(true);
    expect(hasLaborShares({ ...GOOD, laborShareGip: null })).toBe(false);
  });
});

describe("validateRateTableEntry — labor shares (F-211)", () => {
  it("accepts the CMS-shaped band edges", () => {
    expect(validateRateTableEntry({ ...GOOD, laborShareRhc: "0.3", laborShareGip: "0.9" }).ok).toBe(
      true,
    );
  });
  it("rejects a percent (68.71), a 5-place fraction, a non-numeric value, and out-of-band fractions", () => {
    for (const bad of ["68.71", "0.68711", "abc", "", "0.2999", "0.9001", "-0.5"]) {
      const r = validateRateTableEntry({ ...GOOD, laborShareChc: bad });
      expect(r.ok, bad).toBe(false);
    }
  });
  it("names the offending field", () => {
    const r = validateRateTableEntry({ ...GOOD, laborShareIrc: "0.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/laborShareIrc/);
  });
});
