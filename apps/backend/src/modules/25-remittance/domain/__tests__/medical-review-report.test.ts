// M25 milestone 9a-2 - the leadership medical-review report. Pure: window validation, rates, medians and
// period-over-period change. Figures only: there is no target, benchmark or threshold anywhere in this file.
import { describe, expect, it } from "vitest";
import {
  REPORT_MAX_RANGE_DAYS,
  centsToDollars,
  compareMoney,
  comparePeriods,
  median,
  rate,
  resolveReportWindow,
  topN,
} from "../medical-review-report";

const TODAY = new Date("2026-06-15T12:00:00Z");

describe("resolveReportWindow", () => {
  it("returns the inclusive window and the previous period of equal length", () => {
    const r = resolveReportWindow({ from: "2026-06-01", to: "2026-06-10" }, TODAY);
    expect(r).toEqual({
      ok: true,
      window: {
        from: "2026-06-01",
        to: "2026-06-10",
        days: 10,
        previous: { from: "2026-05-22", to: "2026-05-31" },
        startsAt: "2026-06-01T00:00:00.000Z",
        endsBefore: "2026-06-11T00:00:00.000Z",
        previousStartsAt: "2026-05-22T00:00:00.000Z",
      },
    });
  });

  it("accepts today as the last day and a single-day window", () => {
    const r = resolveReportWindow({ from: "2026-06-15", to: "2026-06-15" }, TODAY);
    expect(r.ok && r.window.days).toBe(1);
  });

  it("refuses a date that is not a real calendar day", () => {
    expect(resolveReportWindow({ from: "2026-02-30", to: "2026-03-01" }, TODAY)).toEqual({
      ok: false,
      reason: "INVALID_DAY",
    });
    expect(resolveReportWindow({ from: "2026-6-1", to: "2026-06-10" }, TODAY)).toMatchObject({
      reason: "INVALID_DAY",
    });
  });

  it("refuses from after to, a future end, and a span over the named query bound", () => {
    expect(resolveReportWindow({ from: "2026-06-10", to: "2026-06-01" }, TODAY)).toMatchObject({
      reason: "FROM_AFTER_TO",
    });
    expect(resolveReportWindow({ from: "2026-06-01", to: "2026-06-16" }, TODAY)).toMatchObject({
      reason: "TO_IN_FUTURE",
    });
    expect(resolveReportWindow({ from: "2025-01-01", to: "2026-06-15" }, TODAY)).toMatchObject({
      reason: "RANGE_TOO_LONG",
    });
    expect(REPORT_MAX_RANGE_DAYS).toBe(366);
    expect(resolveReportWindow({ from: "2025-06-15", to: "2026-06-15" }, TODAY).ok).toBe(true);
  });
});

describe("rate and median", () => {
  it("is null when the denominator is 0, never 0 or NaN", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 4)).toBe(0.75);
    expect(median([])).toBeNull();
  });
  it("takes the middle value, averaging the two middle values of an even set", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("comparePeriods", () => {
  it("reports the plain difference and leaves it null when either side has no data", () => {
    expect(comparePeriods(7, 4)).toEqual({ value: 7, previous: 4, change: 3 });
    expect(comparePeriods(2, 5)).toEqual({ value: 2, previous: 5, change: -3 });
    expect(comparePeriods(null, 5)).toEqual({ value: null, previous: 5, change: null });
    expect(comparePeriods(5, null)).toEqual({ value: 5, previous: null, change: null });
  });
});

describe("topN", () => {
  it("ranks by count then dollars then key, and keeps the rest as a count", () => {
    const rows = [
      { key: "b", count: 2, cents: 10 },
      { key: "a", count: 2, cents: 10 },
      { key: "c", count: 5, cents: 1 },
      { key: "d", count: 2, cents: 99 },
    ];
    const r = topN(rows, 3);
    expect(r.shown.map((x) => x.key)).toEqual(["c", "d", "a"]);
    expect(r.omitted).toBe(1);
  });
});

describe("money is exact", () => {
  it("formats integer cents without float drift", () => {
    expect(centsToDollars(0)).toBe("0.00");
    expect(centsToDollars(5)).toBe("0.05");
    expect(centsToDollars(123456)).toBe("1234.56");
    expect(centsToDollars(-250)).toBe("-2.50");
    // 0.1 + 0.2 style sums: ten amounts of 10 cents are exactly one dollar.
    expect(centsToDollars(Array.from({ length: 10 }, () => 10).reduce((a, b) => a + b, 0))).toBe(
      "1.00",
    );
  });
  it("compares two periods as strings", () => {
    expect(compareMoney(16600, 2000)).toEqual({
      value: "166.00",
      previous: "20.00",
      change: "146.00",
    });
    expect(compareMoney(0, 150)).toEqual({ value: "0.00", previous: "1.50", change: "-1.50" });
  });
});
