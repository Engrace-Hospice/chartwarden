// @wardenx/emar — §2.3 D2 structured-frequency model + `frequencyCode` parser (M13-T03). PURE, IO-free.
//
// M13 materializes `scheduled_dose` rows from M12's medication order. M12's `MedicationOrderProvider`
// seam projects the sig as `SigStructuredDto.frequencyCode` (a canonical string). The materializer cannot
// step a string, so M13 owns the structured §2.3 frequency union the schedule-parser consumes and the
// `parseFrequencyCode` adapter that maps the canonical M12 codes onto it. The four §2.3 variants —
// `interval` (q4h), `named_times` (BID at 0800/2000), `weekly_named_days` (MWF at 1000), `event_anchored`
// (with meals) — plus the `prn` no-materialization case cover the canonical hospice sig patterns; an
// unrecognized code raises {@link FrequencyParseError} so the calling worker (M13-T08) routes it to the
// manual-review queue rather than silently materializing nothing.
import { ChartWardenError } from "@wardenx/types";
import type { WeekdayKey } from "./time";

/** A `HH:mm` order-local time-of-day (24h). The materializer resolves it to an instant per calendar day. */
export type LocalTimeOfDay = string;

/** A meal/event anchor an `event_anchored` frequency pins to (tenant meal-time map resolves the clock). */
export type MealEvent = "breakfast" | "lunch" | "dinner" | "bedtime";

/**
 * §2.3 — the structured frequency the schedule-parser steps. Each variant yields a set of order-local
 * times-of-day; the materializer projects those across the window in the order's timezone (DST-exact).
 */
export type ScheduleFrequency =
  /** A fixed interval anchored to a start-of-day time (q4h → 00:00, 04:00, … ; q6h ATC; etc.). */
  | { readonly kind: "interval"; readonly everyMinutes: number; readonly anchor: LocalTimeOfDay }
  /** Explicit clock times every day (BID at 08:00/20:00; QID at 06/12/18/22). */
  | { readonly kind: "named_times"; readonly times: readonly LocalTimeOfDay[] }
  /** Specific weekdays at specific times (MWF at 10:00; once-weekly Thursday at 09:00). */
  | {
      readonly kind: "weekly_named_days";
      readonly days: readonly WeekdayKey[];
      readonly times: readonly LocalTimeOfDay[];
    }
  /** Pinned to meal/event anchors; the tenant meal-time map resolves the clock at materialize time. */
  | { readonly kind: "event_anchored"; readonly events: readonly MealEvent[] }
  /** PRN / as-needed / titrate-to-effect — NO scheduled rows materialize (§2.3); administered on demand. */
  | { readonly kind: "prn" };

/** Raised when a `frequencyCode` cannot be mapped onto a {@link ScheduleFrequency} (§2.3 manual-review). */
export class FrequencyParseError extends ChartWardenError {
  constructor(public readonly frequencyCode: string) {
    super(
      "FREQUENCY_NOT_PARSEABLE",
      `medication-order frequency code '${frequencyCode}' is not a recognized scheduled pattern`,
      422,
    );
    this.name = "FrequencyParseError";
  }
}

/** Canonical named-time sets for the common hospice administration-times codes (§2.3 "150 sig patterns"). */
const NAMED_TIME_SETS: Readonly<Record<string, readonly LocalTimeOfDay[]>> = {
  qd: ["09:00"], // once daily (morning)
  daily: ["09:00"],
  qday: ["09:00"],
  qam: ["09:00"], // every morning
  qpm: ["17:00"], // every evening
  qhs: ["21:00"], // at bedtime
  bid: ["08:00", "20:00"], // twice daily
  tid: ["08:00", "14:00", "20:00"], // three times daily
  qid: ["08:00", "12:00", "16:00", "20:00"], // four times daily
};

/** Canonical interval codes → minutes (anchored at midnight, §2.3 ATC dosing). */
const INTERVAL_MINUTES: Readonly<Record<string, number>> = {
  q1h: 60,
  q2h: 120,
  q3h: 180,
  q4h: 240,
  q6h: 360,
  q8h: 480,
  q12h: 720,
};

/** Canonical weekly day-abbreviation → {@link WeekdayKey}. */
const WEEKDAY_ABBR: Readonly<Record<string, WeekdayKey>> = {
  su: "sun",
  m: "mon",
  tu: "tue",
  w: "wed",
  th: "thu",
  f: "fri",
  sa: "sat",
};

/** Normalize a raw `frequencyCode` for matching: lowercase, strip spaces/hyphens/underscores. */
function normalize(code: string): string {
  return code.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Split a normalized weekly token like `mwf` / `tuth` into its {@link WeekdayKey} list. */
function parseWeekdayToken(token: string): WeekdayKey[] | null {
  const days: WeekdayKey[] = [];
  let i = 0;
  while (i < token.length) {
    // Two-letter abbreviations (su, tu, th, sa) take priority over their one-letter prefixes.
    const two = token.slice(i, i + 2);
    const one = token.slice(i, i + 1);
    if (WEEKDAY_ABBR[two]) {
      days.push(WEEKDAY_ABBR[two] as WeekdayKey);
      i += 2;
    } else if (WEEKDAY_ABBR[one]) {
      days.push(WEEKDAY_ABBR[one] as WeekdayKey);
      i += 1;
    } else {
      return null;
    }
  }
  return days.length > 0 ? days : null;
}

/**
 * §2.3 — map an M12 `SigStructuredDto.frequencyCode` (+ the order's `asNeeded` flag) onto a structured
 * {@link ScheduleFrequency}. `asNeeded` short-circuits to `prn` (no rows materialize) regardless of the
 * code — a "PRN q4h ≥ 4" soft-schedule order is PRN, the q4h being the minimum-interval rule the PRN write
 * path enforces, not a materialization cadence (§2.3 as-needed-with-soft-schedule). Unrecognized codes raise
 * {@link FrequencyParseError}.
 */
export function parseFrequencyCode(frequencyCode: string, asNeeded = false): ScheduleFrequency {
  const code = normalize(frequencyCode);
  if (asNeeded || code === "prn" || code === "asneeded") return { kind: "prn" };

  const interval = INTERVAL_MINUTES[code];
  if (interval !== undefined) return { kind: "interval", everyMinutes: interval, anchor: "00:00" };

  const named = NAMED_TIME_SETS[code];
  if (named) return { kind: "named_times", times: named };

  // Meal-anchored codes (ac = before meals, cc = with meals, pc = after meals → three meal events).
  if (code === "ac" || code === "cc" || code === "pc" || code === "withmeals") {
    return { kind: "event_anchored", events: ["breakfast", "lunch", "dinner"] };
  }

  // Weekly day-of-week codes, optionally `@HH:mm` (e.g. `mwf`, `tuth@09:00`). Default to a 09:00 morning dose.
  const weeklyMatch = /^([a-z]+?)(?:@(\d{2}:\d{2}))?$/.exec(code);
  if (weeklyMatch) {
    const days = parseWeekdayToken(weeklyMatch[1] as string);
    if (days) return { kind: "weekly_named_days", days, times: [weeklyMatch[2] ?? "09:00"] };
  }

  throw new FrequencyParseError(frequencyCode);
}
