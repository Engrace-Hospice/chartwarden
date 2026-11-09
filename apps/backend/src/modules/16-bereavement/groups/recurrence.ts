// apps/backend/src/modules/16-bereavement/groups/recurrence.ts — ADR-0109 D10 (PR 3): a recurring support group's sessions, PURE.
//
// A recurring group meets `count` times, every `intervalWeeks` weeks, from `firstDate` at the group-local wall time `startTime` in the group's IANA
// `timezone`. The wall time is KEPT across a DST change (a 6pm group stays at 6pm local, so its UTC instant moves by an hour), which is why the
// instant is resolved per session and not by adding a fixed number of milliseconds. `Intl` resolves the zone offset; no clock, no IO.
import type { BereavementGroupRecurrence } from "@chartwarden/types";

export const GROUP_RECURRENCE_LIMITS = {
  count: { min: 1, max: 52 },
  intervalWeeks: { min: 1, max: 4 },
  durationMinutes: { min: 15, max: 480 },
} as const;

const DAY_MS = 86_400_000;
const DATE_SHAPE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface MaterializedSession {
  readonly sessionNo: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** True for a timezone `Intl` knows (an unknown zone throws a RangeError). */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `localWallClock − UTC` in ms for `timeZone` at the instant `utcMs` (west of UTC is negative). */
function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return wall - Math.floor(utcMs / 60_000) * 60_000;
}

/**
 * The UTC instant of wall time `time` on `date` in `timeZone`. Two passes: the offset is re-read at the first guess, so a date on the other side of
 * a DST change resolves with ITS offset. A wall time skipped by spring-forward lands on the post-transition instant.
 */
export function wallTimeToUtc(date: string, time: string, timeZone: string): Date {
  const wall = Date.parse(`${date}T${time}:00.000Z`);
  const guess = wall - offsetMs(wall, timeZone);
  const candidate = wall - offsetMs(guess, timeZone);
  // The candidate does not read back as this wall time only when the wall time does not exist (spring-forward): keep the post-transition guess.
  return new Date(offsetMs(candidate, timeZone) === offsetMs(guess, timeZone) ? candidate : guess);
}

const inRange = (n: number, r: { readonly min: number; readonly max: number }): boolean =>
  Number.isInteger(n) && n >= r.min && n <= r.max;

/** Why a recurrence is malformed, or null when it is usable. */
export function recurrenceProblem(
  rec: BereavementGroupRecurrence,
  timeZone: string,
): string | null {
  if (!isKnownTimeZone(timeZone)) return "timezone is not a known IANA zone";
  if (!DATE_SHAPE.test(rec.firstDate) || Number.isNaN(Date.parse(`${rec.firstDate}T00:00:00Z`))) {
    return "firstDate must be a YYYY-MM-DD date";
  }
  // `2026-02-30` parses (it rolls over); refuse it rather than silently meeting on March 2nd.
  if (new Date(`${rec.firstDate}T00:00:00Z`).toISOString().slice(0, 10) !== rec.firstDate) {
    return "firstDate is not a calendar date";
  }
  if (!TIME_SHAPE.test(rec.startTime)) return "startTime must be HH:MM (24-hour)";
  if (!inRange(rec.count, GROUP_RECURRENCE_LIMITS.count)) return "count is out of range";
  if (!inRange(rec.intervalWeeks, GROUP_RECURRENCE_LIMITS.intervalWeeks)) {
    return "intervalWeeks is out of range";
  }
  if (!inRange(rec.durationMinutes, GROUP_RECURRENCE_LIMITS.durationMinutes)) {
    return "durationMinutes is out of range";
  }
  return null;
}

/** Every session of a (valid) recurrence, numbered from 1. Call {@link recurrenceProblem} first. */
export function materializeSessions(
  rec: BereavementGroupRecurrence,
  timeZone: string,
): MaterializedSession[] {
  const first = Date.parse(`${rec.firstDate}T00:00:00Z`);
  return Array.from({ length: rec.count }, (_, i) => {
    const date = new Date(first + i * rec.intervalWeeks * 7 * DAY_MS).toISOString().slice(0, 10);
    const startsAt = wallTimeToUtc(date, rec.startTime, timeZone);
    return {
      sessionNo: i + 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + rec.durationMinutes * 60_000),
    };
  });
}
