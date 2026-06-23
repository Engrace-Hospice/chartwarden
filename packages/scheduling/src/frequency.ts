// @wardenx/scheduling — the §2.2.4 / §7.7 D5 care-plan FrequencyValue parser (M17-T04). Pure, IO-free.
//
// M7 stores an intervention's cadence as a structured `frequency` string in the canonical hospice form the
// frequency-driven proposal worker reads via `CarePlanReader.activeInterventionsWithFrequency` (D5). The
// grammar is the SAME pattern M7 and M15 use (spec §7.7):
//
//     ^([0-9]+):(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$
//
// i.e. `<count>:<unit>:<period>` — "2:visit:week" is two visits per week, "1:visit:episode" is one visit
// per episode, "1:prn:prn" / "1:continuous:day" are as-needed / continuous cadences that DO NOT auto-propose
// (the scheduler/clinician drives those). This module parses+validates the string and derives the cadence
// interval (the whole-day spacing between consecutive proposed visits) the proposal builder steps on. The
// `frequency` value mirrors `@wardenx/types` `RelevantIntervention.frequencyText` but the parsed form is
// local to M17's proposal domain (the spec calls it "a tiny type shared by import"). No DB, no cross-module
// schema import.
import { SchedulingStateError } from "./lifecycle/errors";

/** The countable thing in a cadence (the middle token). `prn`/`continuous` are non-cadenced. */
export type FrequencyUnit = "visit" | "day" | "week" | "month" | "prn" | "continuous";

/** The cadence period (the trailing token) the count is per. `episode`/`prn` are non-cadenced. */
export type FrequencyPeriod = "day" | "week" | "month" | "episode" | "prn";

/** The locked §7.7 unit / period value sets (the parser validates the captured tokens against these). */
export const FREQUENCY_UNITS = ["visit", "day", "week", "month", "prn", "continuous"] as const;
export const FREQUENCY_PERIODS = ["day", "week", "month", "episode", "prn"] as const;

/** A parsed + validated care-plan frequency (the output of {@link parseFrequency}). */
export interface FrequencyValue {
  /** The leading positive-integer count (`2` in `2:visit:week`). */
  readonly count: number;
  /** The countable thing (`visit` in `2:visit:week`). */
  readonly unit: FrequencyUnit;
  /** The period the count is per (`week` in `2:visit:week`). */
  readonly period: FrequencyPeriod;
  /** The canonical source string (kept verbatim for the proposal `source_payload` audit). */
  readonly raw: string;
}

/** Whole calendar days in one cadence period; `episode`/`prn` carry no fixed span (non-cadenced). */
const PERIOD_DAYS: Readonly<Record<FrequencyPeriod, number | null>> = {
  day: 1,
  week: 7,
  month: 30, // the §7.7 nominal month (hospice cadence is sub-month; D4 excludes true monthly recurrence)
  episode: null,
  prn: null,
};

const FREQUENCY_GRAMMAR =
  /^([0-9]+):(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$/;

/**
 * Parse + validate an M7/M15 care-plan `frequency` string against the locked §7.7 grammar. Throws
 * {@link SchedulingStateError} `FREQUENCY_UNPARSEABLE` for anything that does not match `count:unit:period`
 * with a positive (non-zero) count and a recognized unit/period. Whitespace is trimmed; the match is
 * exact otherwise (case-sensitive, lower-case tokens — the canonical stored form).
 */
export function parseFrequency(raw: string): FrequencyValue {
  const trimmed = raw.trim();
  const m = FREQUENCY_GRAMMAR.exec(trimmed);
  if (!m) {
    throw new SchedulingStateError(
      "FREQUENCY_UNPARSEABLE",
      `frequency '${raw}' does not match the count:unit:period grammar`,
    );
  }
  const count = Number(m[1]);
  if (!Number.isInteger(count) || count < 1) {
    throw new SchedulingStateError(
      "FREQUENCY_UNPARSEABLE",
      `frequency '${raw}' must carry a positive integer count`,
    );
  }
  return { count, unit: m[2] as FrequencyUnit, period: m[3] as FrequencyPeriod, raw: trimmed };
}

/**
 * Whether the frequency carries a fixed time cadence the proposal worker can step on. `prn` / `continuous`
 * units and `prn` / `episode` periods are NON-cadenced — they describe as-needed, continuous, or
 * once-per-episode care the scheduler/clinician schedules directly, never the nightly cron (D5: only
 * cadenced frequencies materialize proposals).
 */
export function isCadencedFrequency(freq: FrequencyValue): boolean {
  return frequencyCadenceDays(freq) !== null;
}

/**
 * The whole-day spacing between consecutive proposed visits for a cadenced frequency, or `null` when the
 * frequency is non-cadenced (see {@link isCadencedFrequency}). The interval is `round(periodDays / count)`
 * floored at 1 — `2:visit:week` → `round(7/2)=4` (≈ twice-weekly), `3:visit:week` → `round(7/3)=2`,
 * `1:visit:week` → `7`, `1:visit:day` → `1`. Deterministic; no clock read.
 */
export function frequencyCadenceDays(freq: FrequencyValue): number | null {
  if (freq.unit === "prn" || freq.unit === "continuous") return null;
  const periodDays = PERIOD_DAYS[freq.period];
  if (periodDays === null) return null;
  return Math.max(1, Math.round(periodDays / freq.count));
}
