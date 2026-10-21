// @chartwarden/orders — org-timezone clock math for the verbal-window + standing-spawn engines (M11-T04).
// PURE, IO-free, `Date.now()`-free: every fact (the anchor instant, the org timezone, the holiday set) is
// passed in, so the math is deterministic across timezones and DST boundaries. This mirrors the M10 HOPE
// `scheduling/time.ts` precedent but lives here because `packages/orders` is a leaf feature lib (the backend
// depends on it, never the reverse) and may only import `@chartwarden/types`. `Intl` (ICU ships with the runtime)
// resolves the zone offset, so DST is handled exactly — the spec §2.3 "deadline-at-midnight / DST" edges.
import type { IsoInstant, LocalDate } from "@chartwarden/types";

/** Org timezone default when M2 `organization.timezone` is unset (matches the M6/M10 default). */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/** One hour, in milliseconds (the verbal window is hour-denominated, §2.3). */
export const HOUR_MS = 3_600_000;

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

/** The org-local calendar date (`yyyy-mm-dd`) an arbitrary UTC instant falls on. */
export function orgLocalDate(instant: IsoInstant, timeZone: string): LocalDate {
  const utcMs = Date.parse(instant);
  return toLocalDate(new Date(utcMs + tzOffsetMs(utcMs, timeZone)));
}

/** The UTC instant for `hour:00:00.000` org-local on calendar day `date` (the zone offset is resolved at
 * the target wall instant, so DST transitions are applied exactly). */
export function atOrgLocalHour(date: LocalDate, hour: number, timeZone: string): IsoInstant {
  const wallUTC = Date.parse(`${date}T${pad(hour)}:00:00.000Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/** Day-of-week index for a `yyyy-mm-dd` date: 0 = Sunday … 6 = Saturday (UTC-anchored, so it is the
 * org-local weekday because the date is already the org-local calendar day). */
export function dayOfWeekIndex(date: LocalDate): number {
  return new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
}

/** The three-letter lowercase weekday key (`'mon'`…`'sun'`) for a `yyyy-mm-dd` date (cadence detail). */
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export function weekdayKey(date: LocalDate): WeekdayKey {
  return WEEKDAY_KEYS[dayOfWeekIndex(date)] as WeekdayKey;
}

/** Whether `date` is a business day in `timeZone` given the tenant holiday set: not a weekend (Sat/Sun)
 * and not in `holidays` (a set of `yyyy-mm-dd` org-local dates). */
export function isBusinessDay(date: LocalDate, holidays: ReadonlySet<LocalDate>): boolean {
  const dow = dayOfWeekIndex(date);
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(date);
}
