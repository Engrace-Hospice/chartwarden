import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { resolveAnalyticsWindow } from "../routes/analytics-window";

const NOW = new Date("2026-10-23T15:42:10.000Z");
const iso = (d: Date): string => d.toISOString();
const days = (w: { from: Date; to: Date }): number =>
  (w.to.getTime() - w.from.getTime()) / 86_400_000;

describe("resolveAnalyticsWindow (completed UTC days only)", () => {
  it("snaps from to the start of its UTC day and to to the start of the day AFTER its UTC day", () => {
    const w = resolveAnalyticsWindow(
      { from: "2026-10-01T13:30:00Z", to: "2026-10-10T08:00:00Z" },
      NOW,
    );
    expect(w && iso(w.from)).toBe("2026-10-01T00:00:00.000Z");
    expect(w && iso(w.to)).toBe("2026-10-11T00:00:00.000Z");
  });

  it("returns the identical window for inputs on the same UTC days (a midnight `to` also includes its own day)", () => {
    const a = resolveAnalyticsWindow(
      { from: "2026-10-01T00:00:00Z", to: "2026-10-10T00:00:00Z" },
      NOW,
    );
    const b = resolveAnalyticsWindow(
      { from: "2026-10-01T23:59:59.999Z", to: "2026-10-10T23:59:59.999Z" },
      NOW,
    );
    expect(a).toEqual(b);
  });

  it("caps `to` at the start of the current UTC day: a `to` in the future or today is capped, today is never served", () => {
    const today = "2026-10-23T00:00:00.000Z";
    for (const to of ["2026-10-23T09:00:00Z", "2026-10-23T00:00:00Z", "2026-12-31T00:00:00Z"]) {
      const w = resolveAnalyticsWindow({ from: "2026-10-01T00:00:00Z", to }, NOW);
      expect(w && iso(w.to), to).toBe(today);
    }
    // yesterday as `to` includes yesterday whole and nothing more
    const y = resolveAnalyticsWindow(
      { from: "2026-10-01T00:00:00Z", to: "2026-10-22T05:00:00Z" },
      NOW,
    );
    expect(y && iso(y.to)).toBe(today);
  });

  it("the same request at 01:00 and at 23:00 UTC on one day returns an identical window (injectable clock)", () => {
    const early = new Date("2026-10-23T01:00:00Z");
    const late = new Date("2026-10-23T23:00:00Z");
    for (const q of [
      {},
      { from: "2026-10-01T00:00:00Z" },
      { from: "2026-10-01T00:00:00Z", to: "2026-10-23T12:00:00Z" },
    ]) {
      expect(resolveAnalyticsWindow(q, early)).toEqual(resolveAnalyticsWindow(q, late));
    }
  });

  it("defaults to the 30 completed days before today", () => {
    const w = resolveAnalyticsWindow({}, NOW);
    expect(w && iso(w.to)).toBe("2026-10-23T00:00:00.000Z");
    expect(w && iso(w.from)).toBe("2026-09-23T00:00:00.000Z");
    expect(w && days(w)).toBe(30);
  });

  it("has no window when it holds no completed day (only today, or the future)", () => {
    expect(
      resolveAnalyticsWindow({ from: "2026-10-23T00:00:00Z", to: "2026-10-23T12:00:00Z" }, NOW),
    ).toBeNull();
    expect(
      resolveAnalyticsWindow({ from: "2026-10-24T00:00:00Z", to: "2026-10-30T00:00:00Z" }, NOW),
    ).toBeNull();
  });

  it("applies the 92-day cap AFTER snapping", () => {
    // 91 days and 2 hours apart as instants, but the snapped window is 93 whole days -> refused.
    expect(() =>
      resolveAnalyticsWindow({ from: "2026-06-30T23:00:00Z", to: "2026-09-30T01:00:00Z" }, NOW),
    ).toThrow(ValidationError);
    const ok = resolveAnalyticsWindow(
      { from: "2026-07-01T00:00:00Z", to: "2026-09-30T00:00:00Z" },
      NOW,
    );
    expect(ok && days(ok)).toBe(92);
  });

  it("refuses from after to (as instants) and keeps a same-day past window as one whole day", () => {
    expect(() =>
      resolveAnalyticsWindow({ from: "2026-10-10T00:00:00Z", to: "2026-10-09T00:00:00Z" }, NOW),
    ).toThrow(ValidationError);
    const w = resolveAnalyticsWindow(
      { from: "2026-10-10T01:00:00Z", to: "2026-10-10T02:00:00Z" },
      NOW,
    );
    expect(w && days(w)).toBe(1);
  });
});
