// @chartwarden/scheduling — org-timezone clock math for the §7.7 RRULE materializer (M17-T03).
// PURE, IO-free, `Date.now()`-free: every fact (the anchor calendar date, the org timezone, the local
// time-of-day) is passed in, so the math is deterministic across timezones and DST boundaries. This mirrors
// the M11 `@chartwarden/orders` `lifecycle/time.ts` precedent but lives here because `packages/scheduling` is a
// leaf feature lib (the backend depends on it, never the reverse) and may only import `@chartwarden/types`.
// `Intl` (ICU ships with the runtime) resolves the zone offset, so DST is handled exactly — the §9.8
// DST-boundary fixture day round-trips because `atOrgLocalTime` re-resolves the offset at the target wall
// instant (a 10:00 local visit is 10:00 local on both sides of the spring-forward / fall-back boundary).
import type { IsoDate, IsoInstant, RruleByDay } from "@chartwarden/types";

/** Org timezone default when M2 `organization.timezone` is unset (matches the M6/M10/M11 default). */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/** Milliseconds in one calendar day. */
export const DAY_MS = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Format a Date's UTC calendar fields as a `yyyy-mm-dd` IsoDate. */
function toIsoDate(dt: Date): IsoDate {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Add (or subtract) whole calendar days to a `yyyy-mm-dd` date; returns a `yyyy-mm-dd` date. */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

/** Whole-day difference `b - a` for two `yyyy-mm-dd` dates (UTC-anchored, so DST-immune). */
export function calendarDaysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Day-of-week index for a `yyyy-mm-dd` date: 0 = Sunday … 6 = Saturday (UTC-anchored, so it is the
 * org-local weekday because the date is already the org-local calendar day). */
export function dayOfWeekIndex(date: IsoDate): number {
  return new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
}

/** The RFC 5545 weekday code (`SU`…`SA`) for a `yyyy-mm-dd` date (index 0 = Sunday). */
const WEEKDAY_CODES: readonly RruleByDay[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export function weekdayCode(date: IsoDate): RruleByDay {
  return WEEKDAY_CODES[dayOfWeekIndex(date)] as RruleByDay;
}

/** The whole-minute offset (ms) of `timeZone` at the instant `utcMs`, i.e. `localWallClock − UTC`. */
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

/**
 * The UTC instant for `HH:MM` org-local wall time on calendar day `date`. The zone offset is resolved at the
 * target wall instant, so DST transitions are applied exactly — a 10:00-local materialized visit lands at
 * 10:00 local on both sides of the spring-forward / fall-back boundary.
 */
export function atOrgLocalTime(date: IsoDate, timeOfDay: string, timeZone: string): IsoInstant {
  const [hh, mm] = timeOfDay.split(":");
  const wallUTC = Date.parse(`${date}T${pad(Number(hh))}:${pad(Number(mm))}:00.000Z`);
  // Offsets on either side of a transition can map the same wall clock to two instants,
  // or to none. Refuse both cases instead of silently placing a visit at the wrong hour.
  const offsets = new Set(
    [-36, -24, -12, 0, 12, 24, 36].map((hours) =>
      tzOffsetMs(wallUTC + hours * 3_600_000, timeZone),
    ),
  );
  const matches = [...offsets]
    .map((offset) => wallUTC - offset)
    .filter((instant) => instant + tzOffsetMs(instant, timeZone) === wallUTC);
  if (matches.length !== 1)
    throw new RangeError(
      `Local time ${date} ${timeOfDay} is ${matches.length ? "ambiguous" : "nonexistent"} in ${timeZone}`,
    );
  return new Date(matches[0]!).toISOString();
}
