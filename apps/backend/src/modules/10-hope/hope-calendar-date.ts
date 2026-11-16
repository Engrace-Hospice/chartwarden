// apps/backend/src/modules/10-hope/hope-calendar-date.ts — real-calendar-date checks the M10 write paths share.
// A regex proves a date is SHAPED like `YYYY-MM-DD`; it says nothing about `2026-02-30`. JavaScript's own date
// parsing is no better: `new Date("2026-02-30T00:00:00Z")` rolls over to March 2, so a value that was parsed and
// a value that was echoed back can silently be two different dates. These helpers decide on the calendar itself.
//
// The strict rule (a real calendar date, an EXPLICIT offset, an instant inside the accepted year range) is applied to the
// date-time inputs M10 turns into a stored date or an outbox payload, and to exactly these: `targetDate` on recording a
// timepoint (`POST .../hope/timepoints`) and on completing an SFV (`POST .../hope/sfv`), `submittedAt` on
// `POST /hope/submissions/{id}/mark-uploaded`, and `submissionDate` on `GET /hope/assessments/{id}/validation`. Other
// date-time fields keep the route's own `date-time` format (a bare `Date.parse`): `targetDate` on `.../correct` is
// required but IGNORED (the server reuses the original record's date), and the date ANSWERS the answer engine stores are
// judged by `normalizeHopeAnswerValue`, which uses `isRealCalendarDate` too.
import { ROUTE_FORMATS } from "@chartwarden/shared/route-kit";
import { ValidationError } from "@chartwarden/types";

/**
 * True when `year`-`month`-`day` is a date that exists (no Feb 30, no month 13, a Feb 29 only in a leap year). The
 * calendar rule is the route kit's own `date` format (one definition for the platform); this only builds its input.
 */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return ROUTE_FORMATS.date?.(text) === true;
}

/** The earliest and latest UTC year an accepted instant may fall in (HOPE data is 21st-century; 9999 is a typo or a probe). */
const EARLIEST_ACCEPTED_YEAR = 1900;
const LATEST_ACCEPTED_YEAR = 2200;

/**
 * RFC 3339 `date-time` with an EXPLICIT offset: `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)`. The route's own `date-time`
 * format is only `!Number.isNaN(Date.parse(v))`, which also accepts a timestamp with no offset (V8 reads it in the
 * SERVER's local time, so the same string is a different instant on a differently configured host), a date with no
 * time, and hour 24 (read as the next midnight). A body that decides a calendar date must not.
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const MAX_HOUR = 23;
const MAX_MINUTE_OR_SECOND = 59;

/**
 * The `YYYY-MM-DD` date an ISO date-time names, or `null` when that date does not exist, the time or offset is out of
 * range (hour 24, minute 60, offset hour 24), there is no explicit offset, or the whole value does not parse as an
 * instant. The date returned is the one the client WROTE (in its own offset), never re-derived through UTC: a
 * clinician's 8 pm visit on June 1 in a western offset is June 1, not the UTC June 2. The instant that was written has
 * its own UTC day, which may differ for an offset timestamp: the date and the instant agree on what was written, not on
 * which UTC day it falls.
 */
export function calendarDateOfIso(isoDateTime: string): string | null {
  const parts = ISO_DATE_TIME.exec(isoDateTime);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const inRange =
    Number(hour) <= MAX_HOUR &&
    Number(minute) <= MAX_MINUTE_OR_SECOND &&
    Number(second ?? 0) <= MAX_MINUTE_OR_SECOND &&
    Number(offsetHour ?? 0) <= MAX_HOUR &&
    Number(offsetMinute ?? 0) <= MAX_MINUTE_OR_SECOND;
  const instant = Date.parse(isoDateTime);
  if (!inRange || Number.isNaN(instant)) return null;
  // The bound is judged on the INSTANT (so `9999-12-31T23:59:59-14:00`, which is already year 10000 in UTC, is refused).
  const utcYear = new Date(instant).getUTCFullYear();
  if (utcYear < EARLIEST_ACCEPTED_YEAR || utcYear > LATEST_ACCEPTED_YEAR) return null;
  return isRealCalendarDate(Number(year), Number(month), Number(day))
    ? `${year}-${month}-${day}`
    : null;
}

/**
 * The calendar date of a body's date-time `field`, or a 422 that names the field and echoes nothing. The recording paths
 * derive their dates from the date this returns, so a nonexistent date is refused instead of rolled forward (a Feb 30
 * used to be stored as March 2 while the J2052B answer said Feb 30).
 */
export function requireCalendarDateTime(value: string, field: string): string {
  const date = calendarDateOfIso(value);
  if (date) return date;
  const message = `${field} must be a real calendar date and time with an explicit offset`;
  throw new ValidationError(message, [{ field, code: "HOPE_INVALID_DATE", message }]);
}

/** `requireCalendarDateTime` for a body's `targetDate`. */
export const requireCalendarTargetDate = (targetDate: string): string =>
  requireCalendarDateTime(targetDate, "targetDate");
