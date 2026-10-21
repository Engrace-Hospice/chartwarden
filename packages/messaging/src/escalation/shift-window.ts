// @wardenx/messaging - the pure shift-window rule behind the EscalationRouter acceptance (M36 WP 4.3, ADR-0057). M19 owns the
// real roster; this is the one tested definition of "is instant T inside a shift that is written in the schedule's wall-clock
// time", used by the in-memory router the contract tests run against and available to M19 as the reference semantics.
//
// Semantics, all stated here once:
//  - A window is written in the SCHEDULE's IANA zone, never the server's. An unknown zone throws; there is no fallback.
//  - Start is inclusive, end is exclusive: [start, end). Two windows that meet (07:00 end, 07:00 start) never overlap or gap.
//  - A window whose end is not after its start crosses midnight (19:00-07:00); `days` names the weekday the shift STARTS on, so the
//    after-midnight part belongs to the previous day's entry.
//  - Comparison is on local wall-clock minutes. Spring-forward: a start inside the skipped hour begins at the first instant after
//    the gap. Fall-back: a repeated hour is inside a window that spans it on both passes. Adjacent windows therefore stay
//    gapless and non-overlapping through both transitions.
//  - KNOWN CONSEQUENCE of the wall-clock rule: in the repeated fall-back hour a handoff at a wall-clock time inside that hour happens
//    TWICE as elapsed time runs (A, B, A, B on 2026-11-01 in New York for a 01:30 handoff). A caller must therefore never re-evaluate
//    the router at a later instant to decide who "owns" a request that was already routed: WP 4.4 records the resolved tier and
//    assignee on the request and keys idempotency on the request, not on the clock.
//  - Every instant is a full ISO-8601 date-time with an explicit offset (Z or +hh:mm); offset-less or non-ISO strings are refused
//    rather than read in the server's zone.
import { ChartWardenError } from "@wardenx/types";

export interface ShiftWindow {
  /** Local wall-clock start, "HH:MM" 24h. */
  readonly startTime: string;
  /** Local wall-clock end, "HH:MM" 24h, exclusive. At or before `startTime` means the window crosses midnight. */
  readonly endTime: string;
  /** Weekdays (0 = Sunday .. 6 = Saturday) the shift starts on. Absent = every day. */
  readonly days?: readonly number[];
}

export interface ShiftSchedule {
  readonly timeZone: string;
  readonly windows: readonly ShiftWindow[];
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function invalid(message: string): ChartWardenError {
  return new ChartWardenError("ESCALATION_SHIFT_INVALID", message, 400);
}

function minutesOf(time: string): number {
  const m = TIME_PATTERN.exec(time);
  if (!m) throw invalid(`shift time "${time}" must be HH:MM (24h)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const created = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, created);
    return created;
  } catch {
    throw invalid(`unknown time zone "${timeZone}"`);
  }
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

const INSTANT_MAX_LENGTH = 40;
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The one instant validator: a full ISO-8601 date-time WITH an explicit offset (`Z` or `+hh:mm`), at most 40 characters, that the
 * runtime can parse. An offset-less string ("2026-06-01T16:00:00") or a loose one ("June 1 2026", a bare date) is refused because
 * the runtime would read it in the server's zone. Returns epoch milliseconds.
 */
export function parseStrictInstant(instantIso: string): number {
  if (
    typeof instantIso !== "string" ||
    instantIso.length > INSTANT_MAX_LENGTH ||
    !INSTANT_PATTERN.test(instantIso)
  ) {
    throw invalid("instant must be an ISO-8601 date-time with an explicit offset (Z or +hh:mm)");
  }
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms)) throw invalid("instant is not a valid ISO-8601 date-time");
  return ms;
}

function localClock(instantIso: string, timeZone: string): { weekday: number; minutes: number } {
  const ms = parseStrictInstant(instantIso);
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS[get("weekday")];
  if (weekday === undefined) throw invalid(`could not read the weekday in "${timeZone}"`);
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Throws unless the window has HH:MM times, a start different from its end, and weekdays 0-6. */
export function validateShiftWindow(window: ShiftWindow): void {
  if (minutesOf(window.startTime) === minutesOf(window.endTime)) {
    throw invalid("a shift window cannot start and end at the same time");
  }
  for (const d of window.days ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6)
      throw invalid(`weekday ${d} must be an integer 0-6`);
  }
}

/** Throws unless the zone is known and EVERY window is valid, so a malformed later window cannot hide behind an earlier match. */
export function validateShiftSchedule(schedule: ShiftSchedule): void {
  formatterFor(schedule.timeZone);
  for (const w of schedule.windows) validateShiftWindow(w);
}

/** Is `instantIso` inside `window`, read in `timeZone`? Start inclusive, end exclusive. */
export function shiftWindowContains(
  timeZone: string,
  window: ShiftWindow,
  instantIso: string,
): boolean {
  validateShiftWindow(window);
  const start = minutesOf(window.startTime);
  const end = minutesOf(window.endTime);
  const { weekday, minutes } = localClock(instantIso, timeZone);
  const startsOn = (day: number) => window.days === undefined || window.days.includes(day);
  if (start < end) return startsOn(weekday) && minutes >= start && minutes < end;
  if (minutes >= start) return startsOn(weekday);
  return minutes < end && startsOn((weekday + 6) % 7);
}

/** Is `instantIso` inside any window of the schedule, read in the schedule's own zone? */
export function scheduleContains(schedule: ShiftSchedule, instantIso: string): boolean {
  validateShiftSchedule(schedule);
  return schedule.windows.some((w) => shiftWindowContains(schedule.timeZone, w, instantIso));
}
