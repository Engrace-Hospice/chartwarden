// @wardenx/quality — M30 measure-period boundary constants + period math (§4 D14). Pure, IO-free.
//
// CMS HQRP/HCI measures compute over a ROLLING 12-month window ending the last day of the prior completed
// calendar quarter (D14). A few measures deviate (CAHPS samples on calendar quarters per CMS cycle) — the
// deviation is data, not code: the per-FY `MEASURE_FY_BOUNDARY_v<FY>` constant carries the default rule
// plus per-measure overrides, so a CMS reference-period change is a versioned-constant PR.
//
// All date math is UTC and produces ISO-8601 `YYYY-MM-DD` strings with EXCLUSIVE upper bounds (`[start,
// end)`), matching the `MeasurePeriod` contract (V-3: `end > start`).
import type { MeasurePeriod, MeasurePeriodKind } from "../contracts";

// -----------------------------------------------------------------------------
// UTC date primitives
// -----------------------------------------------------------------------------

/** Format a `Date` as an ISO-8601 `YYYY-MM-DD` calendar date in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add `n` whole months to a UTC date (clamps within the month via `Date.UTC` normalization). */
export function addMonthsUTC(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}

/** The 0-based calendar quarter (0 = Q1 Jan–Mar … 3 = Q4 Oct–Dec) a date falls in. */
export function quarterOfMonth(month0: number): 0 | 1 | 2 | 3 {
  return Math.floor(month0 / 3) as 0 | 1 | 2 | 3;
}

/** The `{ year, quarter }` (1-based quarter) containing a UTC date. */
export function quarterContaining(d: Date): { readonly year: number; readonly quarter: 1 | 2 | 3 | 4 } {
  const quarter = (quarterOfMonth(d.getUTCMonth()) + 1) as 1 | 2 | 3 | 4;
  return { year: d.getUTCFullYear(), quarter };
}

/** First instant (UTC) of a 1-based calendar quarter — the inclusive lower bound. */
export function startOfQuarterUTC(year: number, quarter: 1 | 2 | 3 | 4): Date {
  return new Date(Date.UTC(year, (quarter - 1) * 3, 1));
}

// -----------------------------------------------------------------------------
// Window builders (return MeasurePeriod with an EXCLUSIVE end)
// -----------------------------------------------------------------------------

/**
 * The prior COMPLETED calendar quarter as a `calendar_quarter` window. If `asOf` is in Q2-2026, the prior
 * completed quarter is Q1-2026 → `[2026-01-01, 2026-04-01)`.
 */
export function priorCompletedQuarterWindow(asOf: Date): MeasurePeriod {
  const current = quarterContaining(asOf);
  const currentStart = startOfQuarterUTC(current.year, current.quarter);
  const priorStart = addMonthsUTC(currentStart, -3);
  return { kind: "calendar_quarter", start: isoDate(priorStart), end: isoDate(currentStart) };
}

/**
 * The ROLLING 12-month window ending the last day of the prior completed calendar quarter (the HQRP/HCI
 * default, D14). The exclusive end is the first day of the quarter CONTAINING `asOf`; the start is 12
 * months earlier. If `asOf` is in Q2-2026 → `[2025-04-01, 2026-04-01)`.
 */
export function rolling12MonthToQuarterWindow(asOf: Date): MeasurePeriod {
  const current = quarterContaining(asOf);
  const end = startOfQuarterUTC(current.year, current.quarter);
  const start = addMonthsUTC(end, -12);
  return { kind: "rolling_12m_to_quarter", start: isoDate(start), end: isoDate(end) };
}

/** A full calendar year as a `calendar_year` window — `[YYYY-01-01, (YYYY+1)-01-01)`. */
export function calendarYearWindow(year: number): MeasurePeriod {
  return {
    kind: "calendar_year",
    start: isoDate(new Date(Date.UTC(year, 0, 1))),
    end: isoDate(new Date(Date.UTC(year + 1, 0, 1))),
  };
}

// -----------------------------------------------------------------------------
// Per-FY boundary constants (default rule + per-measure overrides)
// -----------------------------------------------------------------------------

/** How a measure's reporting window is anchored relative to `asOf`. */
export type PeriodAnchor = "prior_completed_quarter" | "rolling_12m_to_quarter" | "calendar_year";

/** A per-measure period rule: which window shape + anchor to build for a given `asOf`. */
export interface MeasurePeriodRule {
  /** The contract `MeasurePeriodKind` the resolved window declares. */
  readonly kind: MeasurePeriodKind;
  /** The anchoring strategy the window builder applies. */
  readonly anchor: PeriodAnchor;
}

/** The per-FY boundary: the default rule for all measures plus per-measure-code overrides. */
export interface MeasureFyBoundary {
  /** The federal fiscal year these boundaries apply to. */
  readonly fiscalYear: number;
  /** The window rule applied to any measure without an override. */
  readonly defaultRule: MeasurePeriodRule;
  /** Per-`measureCode` overrides (e.g. CAHPS computes on calendar quarters). */
  readonly overrides: Readonly<Record<string, MeasurePeriodRule>>;
}

const ROLLING_DEFAULT: MeasurePeriodRule = {
  kind: "rolling_12m_to_quarter",
  anchor: "rolling_12m_to_quarter",
};

const CALENDAR_QUARTER_RULE: MeasurePeriodRule = {
  kind: "calendar_quarter",
  anchor: "prior_completed_quarter",
};

/** FY2025 measure-period boundaries (D14). HQRP/HCI default rolling-12m; CAHPS on calendar quarters. */
export const MEASURE_FY_BOUNDARY_v2025: MeasureFyBoundary = {
  fiscalYear: 2025,
  defaultRule: ROLLING_DEFAULT,
  overrides: {
    cahps_composite: CALENDAR_QUARTER_RULE,
  },
};

/** FY2026 measure-period boundaries — unchanged window rules vs FY2025 (constant carried forward). */
export const MEASURE_FY_BOUNDARY_v2026: MeasureFyBoundary = {
  fiscalYear: 2026,
  defaultRule: ROLLING_DEFAULT,
  overrides: {
    cahps_composite: CALENDAR_QUARTER_RULE,
  },
};

/** FY2028 measure-period boundaries — adds the HOPE-derived TFP measures on the rolling default (D4). */
export const MEASURE_FY_BOUNDARY_v2028: MeasureFyBoundary = {
  fiscalYear: 2028,
  defaultRule: ROLLING_DEFAULT,
  overrides: {
    cahps_composite: CALENDAR_QUARTER_RULE,
  },
};

/** Resolve the period rule for a measure code under a given FY boundary (override → default). */
export function resolvePeriodRule(boundary: MeasureFyBoundary, measureCode: string): MeasurePeriodRule {
  return boundary.overrides[measureCode] ?? boundary.defaultRule;
}

/** Build the concrete `MeasurePeriod` for a rule as of a reference date. Pure. */
export function resolvePeriodWindow(rule: MeasurePeriodRule, asOf: Date): MeasurePeriod {
  switch (rule.anchor) {
    case "rolling_12m_to_quarter":
      return rolling12MonthToQuarterWindow(asOf);
    case "prior_completed_quarter":
      return priorCompletedQuarterWindow(asOf);
    case "calendar_year":
      return calendarYearWindow(asOf.getUTCFullYear());
  }
}
