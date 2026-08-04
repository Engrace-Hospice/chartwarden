// @wardenx/emar — §2.3 D2 scheduled-dose materializer (M13-T03). PURE, IO-free, `Date.now()`-free.
//
// The §2.3 pipeline: M13 receives `m12.medication_order.active`, reads the order via M12's
// `MedicationOrderProvider.getMedicationOrder` seam, and materializes `scheduled_dose` rows for the next
// `materialization_window_days`. This file is the PURE core of that worker (M13-T08 binds the seam read +
// the row insert): it steps a {@link ScheduleFrequency} across a window in the order's timezone and returns
// the `(dueAtIso, expectedDoseAmount, expectedDoseUnit, expectedRoute)` tuples the worker inserts. No IO;
// the order's dose/route/frequency + the window + the timezone are passed in, so the math is deterministic
// and the spec §2.3 DST/edge cases (`atOrderLocalTime` resolves each slot at its own wall instant) hold.
import type { IsoInstant, LocalDate } from "@wardenx/types";
import { type MealEvent, type ScheduleFrequency, parseFrequencyCode } from "./frequency";
import { addCalendarDays, atOrderLocalTime, weekdayKey } from "./time";

/** One materialized scheduled-dose row's structural payload (§2.3 — the parser's output tuple). */
export interface ScheduledDoseTuple {
  readonly dueAt: IsoInstant;
  readonly expectedDoseAmount: number | null;
  readonly expectedDoseUnit: string | null;
  readonly expectedRoute: string;
}

/** Default order-local meal clock times for `event_anchored` frequencies (tenant override at the worker). */
export const DEFAULT_MEAL_TIMES: Readonly<Record<MealEvent, string>> = {
  breakfast: "08:00",
  lunch: "12:00",
  dinner: "18:00",
  bedtime: "21:00",
};

/** Inputs to {@link materializeSchedule} (every fact resolved upstream; no IO). */
export interface MaterializeOptions {
  /** The order's location timezone (DST-exact slot resolution). */
  readonly timeZone: string;
  /** First order-local calendar day to materialize (inclusive). */
  readonly windowStartDate: LocalDate;
  /** Number of calendar days to materialize from `windowStartDate` (per-tenant default 7, §2.3). */
  readonly windowDays: number;
  /** The order's dose amount (null for non-discrete modes); copied onto every row for survey reconstruction. */
  readonly expectedDoseAmount: number | null;
  readonly expectedDoseUnit: string | null;
  /** The order's route. */
  readonly expectedRoute: string;
  /** Drop any slot at/earlier than this instant (the order activation; never materialize the past). */
  readonly notBeforeInstant?: IsoInstant;
  /** Per-tenant meal clock map override for `event_anchored` frequencies. */
  readonly mealTimes?: Readonly<Record<MealEvent, string>>;
}

/** Split a `HH:mm` time-of-day into `[hour, minute]`. */
function splitTime(t: string): readonly [number, number] {
  const [h, m] = t.split(":");
  return [Number(h), Number(m)] as const;
}

/** The order-local times-of-day this frequency yields on calendar day `date` (empty when the day is off). */
function timesForDate(
  freq: ScheduleFrequency,
  date: LocalDate,
  mealTimes: Readonly<Record<MealEvent, string>>,
): readonly string[] {
  switch (freq.kind) {
    case "prn":
      return [];
    case "named_times":
      return freq.times;
    case "interval": {
      // Step the interval across the 24h day from the anchor; wall-clock-named slots (§2.3 q4h ATC).
      const [ah, am] = splitTime(freq.anchor);
      const start = ah * 60 + am;
      const out: string[] = [];
      for (let mins = start; mins < 24 * 60; mins += freq.everyMinutes) {
        out.push(
          `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`,
        );
      }
      return out;
    }
    case "weekly_named_days":
      return freq.days.includes(weekdayKey(date)) ? freq.times : [];
    case "event_anchored":
      return freq.events.map((e) => mealTimes[e]);
  }
}

/**
 * §2.3 — materialize the scheduled-dose tuples for a frequency across the window. Returns rows in ascending
 * `dueAt` order, de-duplicated by instant (the fall-back DST hour collapses to one row), with any slot at or
 * before `notBeforeInstant` dropped. A `prn` frequency yields `[]` (no rows materialize, §2.3).
 */
export function materializeSchedule(
  freq: ScheduleFrequency,
  opts: MaterializeOptions,
): ScheduledDoseTuple[] {
  if (freq.kind === "prn") return [];
  const mealTimes = opts.mealTimes ?? DEFAULT_MEAL_TIMES;
  const notBeforeMs = opts.notBeforeInstant
    ? Date.parse(opts.notBeforeInstant)
    : Number.NEGATIVE_INFINITY;

  const byInstant = new Map<string, ScheduledDoseTuple>();
  for (let d = 0; d < opts.windowDays; d += 1) {
    const date = addCalendarDays(opts.windowStartDate, d);
    for (const t of timesForDate(freq, date, mealTimes)) {
      const [h, m] = splitTime(t);
      const dueAt = atOrderLocalTime(date, h, m, opts.timeZone);
      if (Date.parse(dueAt) <= notBeforeMs) continue; // never materialize at/before activation
      byInstant.set(dueAt, {
        dueAt,
        expectedDoseAmount: opts.expectedDoseAmount,
        expectedDoseUnit: opts.expectedDoseUnit,
        expectedRoute: opts.expectedRoute,
      });
    }
  }
  return [...byInstant.values()].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

/** The minimal slice of M12's `MedicationOrderDto` the materializer reads (no schema/seam import here). */
export interface MaterializableOrder {
  readonly route: string;
  readonly sigStructured: {
    readonly doseQuantity: number;
    readonly doseUnit: string;
    readonly route: string;
    readonly frequencyCode: string;
    readonly asNeeded: boolean;
  };
  /** The order's `activatedAt` — slots at/before this are dropped (never materialize the past, §2.3). */
  readonly activatedAt: IsoInstant | null;
}

/**
 * §2.3 — the projection entry point: parse the order's `sigStructured` into a {@link ScheduleFrequency} and
 * materialize the window. The M13-T08 worker calls this with the order it read from M12's
 * `MedicationOrderProvider` seam; this stays pure (the seam read + row insert are the worker's job).
 */
export function materializeForOrder(
  order: MaterializableOrder,
  opts: Omit<
    MaterializeOptions,
    "expectedDoseAmount" | "expectedDoseUnit" | "expectedRoute" | "notBeforeInstant"
  > & {
    readonly notBeforeInstant?: IsoInstant;
  },
): ScheduledDoseTuple[] {
  const freq = parseFrequencyCode(order.sigStructured.frequencyCode, order.sigStructured.asNeeded);
  return materializeSchedule(freq, {
    ...opts,
    expectedDoseAmount: order.sigStructured.doseQuantity,
    expectedDoseUnit: order.sigStructured.doseUnit,
    expectedRoute: order.sigStructured.route || order.route,
    notBeforeInstant: opts.notBeforeInstant ?? order.activatedAt ?? undefined,
  });
}
