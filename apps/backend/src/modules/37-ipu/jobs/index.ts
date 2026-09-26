// apps/backend/src/modules/37-ipu/jobs/index.ts — M37 background jobs (F-071 / #174, §2.3 D3, §4.8).
// Pure, deterministic planning over the §4.8 queue catalog (pure data, no BullMQ import — the worker
// construction binds at app boot; the M7/M9/M10/M14/M25 precedent).
//
// WHAT THIS FIXES. `ipu_rn_coverage_window` is a MATERIALIZED invariant: the spec (§2.3 D3) defines an
// `rn-coverage-watchdog` worker that rebuilds it every 5 minutes per unit, and the pure builder that
// computes the grid has been written and unit-tested in `@wardenx/inpatient` since M37-T07
// (`domain/rn-coverage/window-builder.ts`, whose own header names this worker).
//
// The worker was never built, so nothing ever wrote a row. Four write paths read the table and treat an
// absent row as UNCOVERED — correctly, fail-closed — and `planOpenAdmission` refuses every non-`arranged`
// admission on that flag whether or not a unit was even named. The result was total: **no GIP and no
// inpatient-respite admission could be opened on any deployment**, and the only IPU care the platform
// could record was `arranged` (CoP 418.112 remote inpatient care), which by definition has no unit, no
// bed, no shift and no restraint.
//
// It stayed invisible because it fails closed and because every live suite inserts the coverage row
// itself before opening an admission (`m37-ipu-write.live.test.ts:180`) — the F-030 shape exactly: each
// harness supplies the fact its own production path cannot produce, so the suites prove the GATE and
// nothing proves the PRODUCER.
//
// SCOPE, stated rather than implied. This ships ONE of the four crons §2.3/§2.13 define. The
// `census-snapshot-builder` (D14) is a separate defect with the same shape — `ipu_census_snapshot` also
// has no writer, its pure builder (`domain/census/snapshot-builder.ts`) also has no caller, and M26's
// inpatient cap accrual and M27's Worksheet S-3 IPU service days therefore read 0 forever. It is NOT
// fixed here and remains open on #174: doing it properly needs per-org-local-midnight scheduling and a
// provider-entity-keyed fact load, and half-building a revenue-cycle materializer is worse than leaving
// it named. `restraint-reassessment-watchdog` (D11) and the D13 cleaning-SLA watchdog are likewise open.

/** The §4.8 queue this module owns. */
export const M37_QUEUES = {
  /** Every 5 minutes: rebuild `ipu_rn_coverage_window` for every active unit in every active org. */
  rnCoverageWatchdog: "ipu.rn-coverage-watchdog",
} as const;

export type M37QueueName = (typeof M37_QUEUES)[keyof typeof M37_QUEUES];

/** The §4.8 cron cadence (the scheduler registers this repeatable). §2.3 D3 specifies every 5 minutes. */
export const M37_JOB_SCHEDULES = {
  rnCoverageWatchdog: "*/5 * * * *",
} as const;

/** Per-queue BullMQ parameters, declared as data so boot worker construction reads one source of truth
 *  (the M09-F12 convention: every job declares full parameters). */
export const M37_QUEUE_PARAMS = {
  rnCoverageWatchdog: { priority: 2, attempts: 3, backoff: "exponential 60s", concurrency: 2 },
} as const;

/**
 * §2.3 D3 — the rolling window the watchdog rebuilds: 168 hours back and 48 hours forward.
 *
 * The BACK half is not redundant with the rows a previous tick already wrote. A shift edited
 * retroactively (a nurse's assignment cancelled after the fact, a shift's end time corrected) changes
 * what was true for hours already materialized, and the coverage grid is the compliance record for those
 * hours — "was an RN on duty every hour of last quarter?" is answered from it. Recomputing the past week
 * every tick is what keeps that record equal to the assignment grid rather than to whatever the grid
 * happened to say when the hour passed.
 */
export const COVERAGE_LOOKBACK_HOURS = 168;
export const COVERAGE_LOOKAHEAD_HOURS = 48;
export const COVERAGE_WINDOW_HOURS = COVERAGE_LOOKBACK_HOURS + COVERAGE_LOOKAHEAD_HOURS;

/**
 * §2.3 D3 — the default alert horizon (hours ahead) at which a projected gap raises
 * `m37.shift.coverage_gap_projected`. The platform floor is 8 hours; a tenant may TIGHTEN to as little as
 * 2 and may not loosen below 8. `inpatient_unit.rn_coverage_horizon_hours` carries the per-tenant value,
 * and `resolveAlertHorizonHours` applies the tighten-only rule rather than trusting the column.
 */
export const COVERAGE_ALERT_HORIZON_FLOOR_HOURS = 8;
export const COVERAGE_ALERT_HORIZON_MIN_HOURS = 2;

/**
 * §2.3 — a unit's alert horizon, tighten-only against the platform floor.
 *
 * Tighten-only means a SMALLER horizon is allowed (alert closer to the gap) and a larger one is not, so
 * the clamp is `min(configured, 8)` with a hard lower bound of 2 — not `max`. Getting this backwards
 * would let a tenant set a 72-hour horizon and drown the alert in noise, or a 0-hour one and never fire.
 */
export function resolveAlertHorizonHours(configuredHours: number | null | undefined): number {
  if (configuredHours == null || !Number.isFinite(configuredHours)) {
    return COVERAGE_ALERT_HORIZON_FLOOR_HOURS;
  }
  const tightened = Math.min(configuredHours, COVERAGE_ALERT_HORIZON_FLOOR_HOURS);
  return Math.max(tightened, COVERAGE_ALERT_HORIZON_MIN_HOURS);
}

/** One hour of the rebuilt grid, as the store upserts it. */
export interface CoverageWindowRow {
  readonly unitId: string;
  readonly hourStartAt: Date;
  readonly isCovered: boolean;
  readonly rnAssignmentIds: readonly string[];
}

/** What one unit's tick concluded, for the events the worker publishes. */
export interface CoverageTickOutcome {
  readonly unitId: string;
  /** The CURRENT hour is uncovered → `m37.shift.rn_uncovered` (block-severity, §2.1.A). */
  readonly currentHourUncovered: boolean;
  /** The first uncovered hour within the alert horizon, if any → `m37.shift.coverage_gap_projected`. */
  readonly projectedGapAt: Date | null;
  /** How many of the rebuilt hours are covered — carried on the alert so an operator sees the shape. */
  readonly coveredHours: number;
  readonly totalHours: number;
}

/**
 * §2.3 D3 — read a rebuilt grid and decide which alerts this tick owes.
 *
 * Pure so the two decisions that matter can be tested without Redis or a database: whether the CURRENT
 * hour is uncovered (the block-severity alert), and where the first gap inside the horizon is (the
 * forward-looking one). `nowMs` is injected rather than read, for the same reason.
 *
 * A gap in the PAST is deliberately not alerted on. The backfill half of the window exists to keep the
 * compliance record true, not to re-raise an alarm every five minutes for an hour that has already
 * passed and that nobody can now staff.
 */
export function planCoverageAlerts(
  unitId: string,
  grid: readonly CoverageWindowRow[],
  nowMs: number,
  alertHorizonHours: number,
): CoverageTickOutcome {
  const hourMs = 3_600_000;
  const currentHourStart = Math.floor(nowMs / hourMs) * hourMs;
  const horizonEnd = currentHourStart + alertHorizonHours * hourMs;

  let currentHourUncovered = false;
  let projectedGapAt: Date | null = null;
  let coveredHours = 0;

  for (const row of grid) {
    if (row.isCovered) coveredHours++;
    const ms = row.hourStartAt.getTime();
    if (ms === currentHourStart && !row.isCovered) currentHourUncovered = true;
    // Strictly AFTER the current hour: the current hour's own gap is the block-severity alert above, and
    // reporting it twice would make one problem look like two.
    if (!row.isCovered && ms > currentHourStart && ms < horizonEnd) {
      if (projectedGapAt === null || ms < projectedGapAt.getTime()) {
        projectedGapAt = new Date(ms);
      }
    }
  }

  return {
    unitId,
    currentHourUncovered,
    projectedGapAt,
    coveredHours,
    totalHours: grid.length,
  };
}
