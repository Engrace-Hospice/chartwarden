// apps/backend/__tests__/visit-metrics.test.ts — GAP-131 (M17): the visit-metrics rates are computed, not hard-coded.
import { describe, expect, it } from "vitest";
import { computeVisitMetrics } from "../src/modules/17-scheduling/visit-metrics";

const WINDOW = { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" };
const row = (scheduled: string, actual: string | null, status = "completed") => ({
  scheduledStartedAt: scheduled,
  actualStartedAt: actual,
  status,
});

describe("computeVisitMetrics", () => {
  it("lowers the on-time rate when a started visit arrived after the grace period", () => {
    const m = computeVisitMetrics(
      [
        row("2026-06-02T14:00:00.000Z", "2026-06-02T14:05:00.000Z"),
        row("2026-06-03T14:00:00.000Z", "2026-06-03T14:45:00.000Z"),
      ],
      WINDOW,
    );
    expect(m.onTimeRate).toBe(0.5);
  });

  it("ignores visits outside the window", () => {
    const m = computeVisitMetrics(
      [
        row("2026-06-02T14:00:00.000Z", "2026-06-02T14:00:00.000Z"),
        row("2026-08-02T14:00:00.000Z", "2026-08-02T16:00:00.000Z", "no_show"),
      ],
      WINDOW,
    );
    expect(m).toEqual({ onTimeRate: 1, noShowRate: 0, rescheduleRate: 0 });
  });

  it("computes no-show and reschedule rates over the windowed visits", () => {
    const m = computeVisitMetrics(
      [
        row("2026-06-02T14:00:00.000Z", null, "no_show"),
        row("2026-06-03T14:00:00.000Z", null, "rescheduled"),
        row("2026-06-04T14:00:00.000Z", "2026-06-04T14:00:00.000Z"),
        row("2026-06-05T14:00:00.000Z", "2026-06-05T14:00:00.000Z"),
      ],
      WINDOW,
    );
    expect(m.noShowRate).toBe(0.25);
    expect(m.rescheduleRate).toBe(0.25);
  });

  it("reports 0, never a fabricated 1, when no visit has started", () => {
    const m = computeVisitMetrics([row("2026-06-02T14:00:00.000Z", null, "published")], WINDOW);
    expect(m.onTimeRate).toBe(0);
    expect(computeVisitMetrics([], WINDOW)).toEqual({
      onTimeRate: 0,
      noShowRate: 0,
      rescheduleRate: 0,
    });
  });
});
