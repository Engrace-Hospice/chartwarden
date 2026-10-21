// @chartwarden/inpatient — M37-T07, §2.3 D3. Evaluates the coverage grid against the alert horizon: the
// forward-gap projection (`m37.shift.coverage_gap_projected`), the block-severity current-hour check
// (`m37.shift.rn_uncovered` → the ABAC `m37.ipu.rn_coverage_active`), and the 168h unit-activation gate.
// Pure & IO-free. The horizon is schema-bounded to [8, 168] hours (the inpatient_unit CHECK; architecture
// wins over the spec prose).
import type { CoverageHour } from "./window-builder";
import { hourStartOf } from "./window-builder";

/** §2.3 — the coverage-gap alert horizon floor (hours forward); the inpatient_unit default. */
export const RN_COVERAGE_HORIZON_FLOOR_HOURS = 8;
/** §2.3 — the maximum horizon a tenant may configure (the inpatient_unit CHECK ceiling). */
export const RN_COVERAGE_HORIZON_MAX_HOURS = 168;
/** §2.3 — the forward RN coverage a unit must hold to exit `provisional` (activate): 168 hours = 7 days. */
export const RN_ACTIVATION_FORWARD_HOURS = 168;

const HOUR_MS = 3_600_000;

/** §2.3 — clamp a configured horizon into the schema-legal [8, 168] range. */
export function normalizeHorizonHours(configuredHours: number): number {
  return Math.min(
    RN_COVERAGE_HORIZON_MAX_HOURS,
    Math.max(RN_COVERAGE_HORIZON_FLOOR_HOURS, configuredHours),
  );
}

/** Index a coverage grid by hour-start for O(1) lookup. */
function indexByHour(windows: readonly CoverageHour[]): Map<number, CoverageHour> {
  return new Map(windows.map((w) => [w.hourStartMs, w]));
}

/**
 * §2.3 — is the hour containing `nowMs` uncovered? An unknown (unbuilt) current hour is treated as UNCOVERED
 * (fail-closed): the invariant must be provably held, not merely un-refuted. Drives the block-severity
 * `m37.shift.rn_uncovered` and the `m37.ipu.rn_coverage_active` ABAC predicate.
 */
export function isCurrentHourUncovered(windows: readonly CoverageHour[], nowMs: number): boolean {
  const hour = indexByHour(windows).get(hourStartOf(nowMs));
  return !hour || !hour.isCovered;
}

/** The forward-gap projection the coverage-gap watchdog reports. */
export interface CoverageGapProjection {
  /** The first uncovered hour-start within the horizon, or null if fully covered. */
  readonly firstGapMs: number | null;
  /** The count of uncovered hours within the horizon window. */
  readonly uncoveredCountInHorizon: number;
  /** Whether the CURRENT hour is uncovered (block-severity). */
  readonly currentHourUncovered: boolean;
  /** The ABAC `m37.ipu.rn_coverage_active` reading (false while the current hour is uncovered). */
  readonly rnCoverageActive: boolean;
}

/**
 * §2.3 — project coverage gaps within the alert horizon forward of `nowMs`. `m37.shift.coverage_gap_projected`
 * fires when `firstGapMs !== null`; `m37.shift.rn_uncovered` (block) fires when `currentHourUncovered`.
 */
export function projectCoverageGap(
  windows: readonly CoverageHour[],
  nowMs: number,
  horizonHours: number,
): CoverageGapProjection {
  const horizon = normalizeHorizonHours(horizonHours);
  const byHour = indexByHour(windows);
  const startHour = hourStartOf(nowMs);
  let firstGapMs: number | null = null;
  let uncovered = 0;
  for (let i = 0; i < horizon; i++) {
    const h = startHour + i * HOUR_MS;
    const row = byHour.get(h);
    if (!row || !row.isCovered) {
      uncovered++;
      if (firstGapMs === null) firstGapMs = h;
    }
  }
  const currentHourUncovered = isCurrentHourUncovered(windows, nowMs);
  return {
    firstGapMs,
    uncoveredCountInHorizon: uncovered,
    currentHourUncovered,
    rnCoverageActive: !currentHourUncovered,
  };
}

/**
 * §2.3 — the unit-activation gate: does the unit hold a full 168 hours of forward RN coverage starting at
 * `activationMs`? A unit cannot exit `provisional` until this holds. Every hour in the forward window must be
 * covered (fail-closed on any unbuilt/uncovered hour).
 */
export function hasActivationCoverage(
  windows: readonly CoverageHour[],
  activationMs: number,
): boolean {
  const byHour = indexByHour(windows);
  const startHour = hourStartOf(activationMs);
  for (let i = 0; i < RN_ACTIVATION_FORWARD_HOURS; i++) {
    const row = byHour.get(startHour + i * HOUR_MS);
    if (!row || !row.isCovered) return false;
  }
  return true;
}
