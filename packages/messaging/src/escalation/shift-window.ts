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
import { WardenXError } from "@wardenx/types";

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

function invalid(message: string): WardenXError {
  return new WardenXError("ESCALATION_SHIFT_INVALID", message, 400);
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

function localClock(instantIso: string, timeZone: string): { weekday: number; minutes: number } {
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms)) throw invalid(`instant "${instantIso}" is not a valid ISO-8601 instant`);
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS[get("weekday")];
  if (weekday === undefined) throw invalid(`could not read the weekday in "${timeZone}"`);
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Is `instantIso` inside `window`, read in `timeZone`? Start inclusive, end exclusive. */
export function shiftWindowContains(
  timeZone: string,
  window: ShiftWindow,
  instantIso: string,
): boolean {
  const start = minutesOf(window.startTime);
  const end = minutesOf(window.endTime);
  if (start === end) throw invalid("a shift window cannot start and end at the same time");
  for (const d of window.days ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6)
      throw invalid(`weekday ${d} must be an integer 0-6`);
  }
  const { weekday, minutes } = localClock(instantIso, timeZone);
  const startsOn = (day: number) => window.days === undefined || window.days.includes(day);
  if (start < end) return startsOn(weekday) && minutes >= start && minutes < end;
  if (minutes >= start) return startsOn(weekday);
  return minutes < end && startsOn((weekday + 6) % 7);
}

/** Is `instantIso` inside any window of the schedule, read in the schedule's own zone? */
export function scheduleContains(schedule: ShiftSchedule, instantIso: string): boolean {
  return schedule.windows.some((w) => shiftWindowContains(schedule.timeZone, w, instantIso));
}
