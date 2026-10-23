import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { resolveAnalyticsWindow } from "../routes/analytics-window";

const NOW = new Date("2026-10-23T15:42:10.000Z");
const iso = (d: Date): string => d.toISOString();

describe("resolveAnalyticsWindow", () => {
  it("snaps from to the start of its UTC day and to to the start of the day AFTER its UTC day", () => {
    const w = resolveAnalyticsWindow(
      { from: "2026-10-01T13:30:00Z", to: "2026-10-10T08:00:00Z" },
      NOW,
    );
    expect(iso(w.from)).toBe("2026-10-01T00:00:00.000Z");
    expect(iso(w.to)).toBe("2026-10-11T00:00:00.000Z");
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
    expect(iso(a.from)).toBe(iso(b.from));
    expect(iso(a.to)).toBe(iso(b.to));
  });

  it("defaults to the last 30 days ending with today, snapped", () => {
    const w = resolveAnalyticsWindow({}, NOW);
    expect(iso(w.to)).toBe("2026-10-24T00:00:00.000Z");
    expect(iso(w.from)).toBe("2026-09-23T00:00:00.000Z");
  });

  it("applies the 92-day cap AFTER snapping", () => {
    // 91 days and 2 hours apart as instants, but the snapped window is 93 whole days -> refused.
    expect(() =>
      resolveAnalyticsWindow({ from: "2026-06-30T23:00:00Z", to: "2026-09-30T01:00:00Z" }, NOW),
    ).toThrow(ValidationError);
    // exactly 92 whole days is allowed.
    const ok = resolveAnalyticsWindow(
      { from: "2026-07-01T00:00:00Z", to: "2026-09-30T00:00:00Z" },
      NOW,
    );
    expect((ok.to.getTime() - ok.from.getTime()) / 86_400_000).toBe(92);
  });

  it("refuses from after to (as instants) and keeps a same-day window as one whole day", () => {
    expect(() =>
      resolveAnalyticsWindow({ from: "2026-10-10T00:00:00Z", to: "2026-10-09T00:00:00Z" }, NOW),
    ).toThrow(ValidationError);
    const w = resolveAnalyticsWindow(
      { from: "2026-10-10T01:00:00Z", to: "2026-10-10T02:00:00Z" },
      NOW,
    );
    expect((w.to.getTime() - w.from.getTime()) / 86_400_000).toBe(1);
  });
});
