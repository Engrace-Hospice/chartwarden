// @wardenx/emar — org-timezone clock math for the §2.3 D2 scheduled-dose materializer (M13-T03).
// PURE, IO-free, `Date.now()`-free: every fact (the order timezone, the window start date, the
// per-day local times) is passed in, so the math is deterministic across timezones and DST boundaries.
// This is the M11 `@wardenx/orders` `lifecycle/time.ts` precedent carried forward: `packages/emar` is a
// leaf feature lib (the backend depends on it, never the reverse) and may only import `@wardenx/types`.
// `Intl` (ICU ships with the runtime) resolves the zone offset, so the spec §2.3 DST edges — spring-forward
// skips the 0200 slot, fall-back duplicates it — are handled exactly (the duplicate is de-duped by the
// caller's instant set; the skipped wall time is mapped forward to its post-transition instant).
import type { IsoInstant, LocalDate } from "@wardenx/types";

/** Order timezone default when the patient location timezone is unset (matches the M6/M10/M11 default). */
export const DEFAULT_ORDER_TIME_ZONE = "America/Los_Angeles";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Format a Date's UTC calendar fields as a `yyyy-mm-dd` LocalDate. */
const toLocalDate = (dt: Date): LocalDate =>
  `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

/** Add (or subtract) whole calendar days to a `yyyy-mm-dd` date; returns a `yyyy-mm-dd` date. */
export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  return toLocalDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
}

/**
 * The whole-minute offset (ms) of `timeZone` at the instant `utcMs`, i.e. `localWallClock − UTC`.
 * West-of-UTC zones return a negative offset. Both sides are floored to the minute so the returned
 * offset is the clean zone offset (no sub-minute drift from the source instant's seconds/ms).
 */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const localMinute = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
  );
  return localMinute - Math.floor(utcMs / 60_000) * 60_000;
}

/** The order-local calendar date (`yyyy-mm-dd`) an arbitrary UTC instant falls on. */
export function orderLocalDate(instant: IsoInstant, timeZone: string): LocalDate {
  const utcMs = Date.parse(instant);
  return toLocalDate(new Date(utcMs + tzOffsetMs(utcMs, timeZone)));
}

/**
 * The UTC instant for `hour:minute:00.000` order-local on calendar day `date`. The zone offset is resolved
 * at the *target* wall instant, so DST transitions are applied exactly: a wall time that does not exist on a
 * spring-forward day maps forward to its post-transition instant; a wall time that occurs twice on a
 * fall-back day maps to a single instant (the caller de-dupes identical instants — §2.3).
 */
export function atOrderLocalTime(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): IsoInstant {
  const wallUTC = Date.parse(`${date}T${pad(hour)}:${pad(minute)}:00.000Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/** Day-of-week index for a `yyyy-mm-dd` date: 0 = Sunday … 6 = Saturday (the date is already the
 * order-local calendar day, so the UTC-anchored weekday is the order-local weekday). */
export function dayOfWeekIndex(date: LocalDate): number {
  return new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
}

/** The three-letter lowercase weekday key (`'mon'`…`'sun'`) for a `yyyy-mm-dd` date (cadence detail). */
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export function weekdayKey(date: LocalDate): WeekdayKey {
  return WEEKDAY_KEYS[dayOfWeekIndex(date)] as WeekdayKey;
}
