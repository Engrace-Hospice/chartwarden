// apps/backend/src/modules/29-external-interfaces/listener/quiet-window.ts - GAP-043. PURE.
//
// A feed's `expected_quiet_windows` (M29 spec §4.11.5 `expectedQuietWindow`): periods in which a partner is known to send
// nothing (a clinic that closes overnight, a weekend), so silence must not trip the listener-down breaker.
//
//   [{ "days": [1,2,3,4,5], "start": "20:00", "end": "06:00", "tz": "America/New_York" }]
//
// `days` are weekdays (0 = Sunday) on which the window STARTS; a window whose `end` is not after its `start` runs past
// midnight into the next day. Evaluation is done in the window's own IANA zone through `Intl`, so a DST change moves the
// wall-clock boundary correctly (no manual offsets). `parseQuietWindows` is the write-time validation; a stored value that
// no longer parses is treated as "no quiet window" (fail toward ALERTING - an unreadable exemption must not silence a page).
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WINDOWS = 14;

export interface QuietWindow {
  readonly days: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly tz: string;
}

export type QuietWindowParse =
  | { readonly ok: true; readonly windows: readonly QuietWindow[] }
  | { readonly ok: false; readonly reason: string };

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseWindow(raw: unknown, index: number): QuietWindow | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `window ${index} must be an object`;
  }
  const w = raw as Record<string, unknown>;
  const extra = Object.keys(w).find((k) => !["days", "start", "end", "tz"].includes(k));
  if (extra !== undefined) return `window ${index} has unknown key '${extra}'`;
  const { days, start, end, tz } = w;
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.length > 7 ||
    days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) ||
    new Set(days).size !== days.length
  ) {
    return `window ${index} days must be 1-7 distinct weekdays 0-6 (0 = Sunday)`;
  }
  if (typeof start !== "string" || !HHMM.test(start)) {
    return `window ${index} start must be HH:MM`;
  }
  if (typeof end !== "string" || !HHMM.test(end)) return `window ${index} end must be HH:MM`;
  if (start === end) return `window ${index} start and end must differ`;
  if (typeof tz !== "string" || !validTimeZone(tz)) {
    return `window ${index} tz must be an IANA time zone`;
  }
  return { days: [...(days as number[])], start, end, tz };
}

/** Validate (write time) and normalize a stored/submitted `expected_quiet_windows`. `null`/`undefined` mean none. */
export function parseQuietWindows(raw: unknown): QuietWindowParse {
  if (raw === null || raw === undefined) return { ok: true, windows: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "expectedQuietWindows must be an array" };
  if (raw.length > MAX_WINDOWS) {
    return { ok: false, reason: `expectedQuietWindows may hold at most ${MAX_WINDOWS} windows` };
  }
  const windows: QuietWindow[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseWindow(item, index);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    windows.push(parsed);
  }
  return { ok: true, windows };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The weekday (0 = Sunday) and minute-of-day of `at` in `tz`. */
function localClock(at: Date, tz: string): { readonly weekday: number; readonly minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAYS.indexOf(get("weekday") as (typeof WEEKDAYS)[number]),
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function insideWindow(window: QuietWindow, at: Date): boolean {
  const { weekday, minute } = localClock(at, window.tz);
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const startsToday = window.days.includes(weekday);
  if (start < end) return startsToday && minute >= start && minute < end;
  // Overnight: the tail after midnight belongs to a window that STARTED the previous weekday.
  const startedYesterday = window.days.includes((weekday + 6) % 7);
  return (startsToday && minute >= start) || (startedYesterday && minute < end);
}

/** True when `at` falls inside any of the (already parsed) windows. */
export function inQuietWindow(windows: readonly QuietWindow[], at: Date): boolean {
  return windows.some((w) => insideWindow(w, at));
}

/** Convenience for a stored value: unreadable => not quiet (fail toward alerting). */
export function inStoredQuietWindow(raw: unknown, at: Date): boolean {
  const parsed = parseQuietWindows(raw);
  return parsed.ok && inQuietWindow(parsed.windows, at);
}
