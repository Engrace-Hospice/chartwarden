import { describe, expect, it } from "vitest";
import { previousUsageWindow, usageWindowFor } from "./jobs";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const NO_MIRROR = { currentPeriodStart: null, currentPeriodEnd: null };

describe("usageWindowFor", () => {
  it("returns the mirrored period when now falls inside it", () => {
    const sub = { currentPeriodStart: utc(2026, 3, 15), currentPeriodEnd: utc(2026, 4, 15) };
    expect(usageWindowFor(sub, utc(2026, 3, 15))).toEqual({
      start: utc(2026, 3, 15),
      end: utc(2026, 4, 15),
    });
  });

  it("puts an instant before the mirrored period in the earlier window on the same anchor", () => {
    // A death dated Mar 10 under a [Mar 15, Apr 15) mirror belongs to [Feb 15, Mar 15), not to calendar March
    // (whose key, 2026-03, is the CURRENT period's).
    const sub = { currentPeriodStart: utc(2026, 3, 15), currentPeriodEnd: utc(2026, 4, 15) };
    expect(usageWindowFor(sub, utc(2026, 3, 10))).toEqual({
      start: utc(2026, 2, 15),
      end: utc(2026, 3, 15),
    });
    expect(usageWindowFor(sub, utc(2025, 12, 20))).toEqual({
      start: utc(2025, 12, 15),
      end: utc(2026, 1, 15),
    });
  });

  it("falls back to the calendar month when the mirror has no period or now is past its end", () => {
    const sub = { currentPeriodStart: utc(2026, 3, 15), currentPeriodEnd: utc(2026, 4, 15) };
    expect(usageWindowFor(sub, utc(2026, 4, 20))).toEqual({
      start: utc(2026, 4, 1),
      end: utc(2026, 5, 1),
    });
    expect(usageWindowFor(NO_MIRROR, utc(2026, 3, 10))).toEqual({
      start: utc(2026, 3, 1),
      end: utc(2026, 4, 1),
    });
  });
});

describe("previousUsageWindow", () => {
  it("is the calendar February when now is in March (not Jan 29)", () => {
    const current = usageWindowFor(NO_MIRROR, utc(2026, 3, 10));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2026, 2, 1), end: utc(2026, 3, 1) });
  });

  it("is the calendar April when now is in May (not Mar 31)", () => {
    const current = usageWindowFor(NO_MIRROR, utc(2026, 5, 10));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2026, 4, 1), end: utc(2026, 5, 1) });
  });

  it("is the calendar December across a year boundary", () => {
    const current = usageWindowFor(NO_MIRROR, utc(2026, 1, 3));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2025, 12, 1), end: utc(2026, 1, 1) });
  });

  it("steps a mirrored window back one month on the same anchor day", () => {
    const sub = { currentPeriodStart: utc(2026, 3, 15), currentPeriodEnd: utc(2026, 4, 15) };
    const current = usageWindowFor(sub, utc(2026, 3, 20));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2026, 2, 15), end: utc(2026, 3, 15) });
  });

  it("steps an annual window back a whole year", () => {
    const sub = { currentPeriodStart: utc(2026, 3, 15), currentPeriodEnd: utc(2027, 3, 15) };
    const current = usageWindowFor(sub, utc(2026, 6, 1));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2025, 3, 15), end: utc(2026, 3, 15) });
  });

  it("clamps a month-end anchor to the shorter month's last day", () => {
    const sub = { currentPeriodStart: utc(2026, 3, 31), currentPeriodEnd: utc(2026, 4, 30) };
    const current = usageWindowFor(sub, utc(2026, 4, 1));
    expect(previousUsageWindow(current)).toEqual({ start: utc(2026, 2, 28), end: utc(2026, 3, 31) });
  });
});
