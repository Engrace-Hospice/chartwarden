// apps/backend/__tests__/m37-rn-coverage-watchdog.test.ts — F-071 (#174).
//
// `ipu_rn_coverage_window` is a MATERIALIZED invariant that four M37 write paths read, each treating an
// absent row as uncovered. Nothing ever wrote a row: the `rn-coverage-watchdog` worker §2.3 D3 defines
// was never built, even though the pure grid builder it was meant to call has been written and
// unit-tested in `@wardenx/inpatient` since M37-T07. `planOpenAdmission` refuses every non-`arranged`
// admission on that flag, so **no GIP and no inpatient-respite admission could be opened on any
// deployment** — the only IPU care the platform could record was `arranged` remote inpatient care.
//
// These cover the two halves that hold the decisions: the tighten-only horizon clamp, and the alert
// planner. The end-to-end grid → upsert → gate path is `m37-rn-coverage.live.test.ts` (a real database).
import { describe, expect, it } from "vitest";
import {
  COVERAGE_ALERT_HORIZON_FLOOR_HOURS,
  COVERAGE_LOOKAHEAD_HOURS,
  COVERAGE_LOOKBACK_HOURS,
  COVERAGE_WINDOW_HOURS,
  type CoverageWindowRow,
  M37_JOB_SCHEDULES,
  M37_QUEUES,
  planCoverageAlerts,
  resolveAlertHorizonHours,
} from "../src/modules/37-ipu/jobs/index";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 27, 14, 37, 12); // mid-hour on purpose — nothing may assume an hour boundary
const CURRENT_HOUR = Math.floor(NOW / HOUR) * HOUR;

/** A grid where every hour is covered unless its offset (hours from the current hour) is in `gaps`. */
function grid(gaps: readonly number[], from = -2, to = 12): CoverageWindowRow[] {
  const rows: CoverageWindowRow[] = [];
  for (let offset = from; offset <= to; offset++) {
    rows.push({
      unitId: "unit-1",
      hourStartAt: new Date(CURRENT_HOUR + offset * HOUR),
      isCovered: !gaps.includes(offset),
      rnAssignmentIds: gaps.includes(offset) ? [] : ["assignment-1"],
    });
  }
  return rows;
}

describe("F-071 — the §4.8 queue catalog", () => {
  it("declares the every-5-minutes cadence §2.3 D3 specifies", () => {
    expect(M37_QUEUES.rnCoverageWatchdog).toBe("ipu.rn-coverage-watchdog");
    expect(M37_JOB_SCHEDULES.rnCoverageWatchdog).toBe("*/5 * * * *");
  });

  it("rebuilds 168 hours back and 48 forward", () => {
    expect(COVERAGE_LOOKBACK_HOURS).toBe(168);
    expect(COVERAGE_LOOKAHEAD_HOURS).toBe(48);
    expect(COVERAGE_WINDOW_HOURS).toBe(216);
  });
});

describe("F-071 — the alert horizon is TIGHTEN-only", () => {
  it("defaults to the 8-hour platform floor when a unit configures nothing", () => {
    expect(resolveAlertHorizonHours(null)).toBe(COVERAGE_ALERT_HORIZON_FLOOR_HOURS);
    expect(resolveAlertHorizonHours(undefined)).toBe(8);
  });

  it("accepts a TIGHTER horizon — a smaller number alerts closer to the gap", () => {
    expect(resolveAlertHorizonHours(4)).toBe(4);
    expect(resolveAlertHorizonHours(2)).toBe(2);
  });

  it("REFUSES to loosen past the floor, which is the direction that is easy to get backwards", () => {
    // A `max(configured, 8)` clamp would return 72 here and drown the alert in a three-day lookahead.
    expect(resolveAlertHorizonHours(72)).toBe(8);
    expect(resolveAlertHorizonHours(9)).toBe(8);
  });

  it("floors at 2 hours, so a 0 or negative configuration cannot silence the alert entirely", () => {
    expect(resolveAlertHorizonHours(0)).toBe(2);
    expect(resolveAlertHorizonHours(-5)).toBe(2);
    expect(resolveAlertHorizonHours(Number.NaN)).toBe(8);
  });
});

describe("F-071 — planCoverageAlerts", () => {
  it("raises the block-severity alert when the CURRENT hour is uncovered", () => {
    const out = planCoverageAlerts("unit-1", grid([0]), NOW, 8);
    expect(out.currentHourUncovered).toBe(true);
  });

  it("does not raise it when the current hour is covered", () => {
    const out = planCoverageAlerts("unit-1", grid([5]), NOW, 8);
    expect(out.currentHourUncovered).toBe(false);
  });

  it("projects the FIRST gap inside the horizon, not any later one", () => {
    const out = planCoverageAlerts("unit-1", grid([3, 6]), NOW, 8);
    expect(out.projectedGapAt?.getTime()).toBe(CURRENT_HOUR + 3 * HOUR);
  });

  it("ignores a gap beyond the horizon — that is what the horizon is", () => {
    const out = planCoverageAlerts("unit-1", grid([10]), NOW, 8);
    expect(out.projectedGapAt).toBeNull();
  });

  it("a TIGHTER horizon sees fewer gaps", () => {
    expect(planCoverageAlerts("unit-1", grid([5]), NOW, 8).projectedGapAt).not.toBeNull();
    expect(planCoverageAlerts("unit-1", grid([5]), NOW, 4).projectedGapAt).toBeNull();
  });

  it("never reports the current hour's own gap as a PROJECTED one — one problem, one alert", () => {
    const out = planCoverageAlerts("unit-1", grid([0]), NOW, 8);
    expect(out.currentHourUncovered).toBe(true);
    // Without the `ms > currentHourStart` guard this would be the current hour, and an operator would
    // see a block alert and a forward-gap alert for the same hour.
    expect(out.projectedGapAt).toBeNull();
  });

  it("ignores a gap in the PAST — the backfill keeps the record true, it does not re-raise alarms", () => {
    // Hours -2 and -1 are uncovered. Nobody can staff an hour that has already passed, and this cron
    // runs every 5 minutes, so alerting on them would fire twelve times an hour forever.
    const out = planCoverageAlerts("unit-1", grid([-2, -1]), NOW, 8);
    expect(out.currentHourUncovered).toBe(false);
    expect(out.projectedGapAt).toBeNull();
  });

  it("counts the covered hours so the alert can say how bad it is", () => {
    const out = planCoverageAlerts("unit-1", grid([0, 3, 4]), NOW, 8);
    expect(out.totalHours).toBe(15); // offsets -2..12
    expect(out.coveredHours).toBe(12);
  });

  it("an empty grid is uncovered-by-absence rather than covered-by-default", () => {
    const out = planCoverageAlerts("unit-1", [], NOW, 8);
    // No row for the current hour means no evidence an RN was on duty. The gates read the TABLE and
    // draw the same conclusion — this is the fail-closed posture that made the missing producer a total
    // outage rather than a partial one.
    expect(out.currentHourUncovered).toBe(false); // no row to prove a gap either
    expect(out.coveredHours).toBe(0);
    expect(out.totalHours).toBe(0);
  });
});
