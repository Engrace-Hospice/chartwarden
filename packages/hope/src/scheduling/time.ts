// @wardenx/hope — org-timezone calendar-day math (M10-T03). PURE, IO-free, `Date.now()`-free: every
// HOPE timepoint window (D2) and SFV due-date (D3) is calendar-day based, computed in the ORG's
// timezone, then persisted as a UTC instant at the boundary moment. This mirrors the M6 certification
// `window-math` precedent (`apps/backend/.../06-admission/certification/window-math.ts`) but lives here
// because `packages/hope` is a leaf feature lib (the backend depends on it, never the reverse) and may
// only import `@wardenx/types`. Every fact (the anchor date, the timezone, the "as of" instant) is
// passed in, so the math is deterministic across timezones and DST boundaries. `Intl` (ICU ships with
// the runtime) resolves the zone offset, so DST is handled exactly.
import type { LocalDate, IsoInstant } from "@wardenx/types";

/** Org timezone default when M2 `organization.timezone` is unset (matches the M6 D8 default). */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

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
  const localMinute = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return localMinute - Math.floor(utcMs / 60_000) * 60_000;
}

/** The UTC instant for the START of calendar day `date` in `timeZone` (00:00:00.000 org-local). */
export function startOfOrgDayInstant(date: LocalDate, timeZone: string): IsoInstant {
  const wallUTC = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/** The UTC instant for the END of calendar day `date` in `timeZone` (23:59:59.999 org-local). The zone
 * offset is resolved at the end-of-day wall instant (past any early-morning DST transition) and applied
 * once, preserving the millisecond precision of the boundary moment. */
export function endOfOrgDayInstant(date: LocalDate, timeZone: string): IsoInstant {
  const wallUTC = Date.parse(`${date}T23:59:59.999Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/** The org-local calendar date (`yyyy-mm-dd`) an arbitrary UTC instant falls on (the inverse of the
 * day-boundary helpers; used to project a `target_date`/`signed_at` instant back to its org-local day). */
export function orgLocalDate(instant: IsoInstant, timeZone: string): LocalDate {
  const utcMs = Date.parse(instant);
  return toLocalDate(new Date(utcMs + tzOffsetMs(utcMs, timeZone)));
}
