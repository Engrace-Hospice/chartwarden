// @wardenx/messaging — per-recipient channel selection (M36-T04, spec §2.1, §2.5, §3.6).
//
// The pure, DB-agnostic core of "which channels does THIS recipient get for THIS alert".
// Reads the recipient's `user_notification_preferences` row shape (§3.6 routing_map /
// quiet_hours / vacation_*) and the alert's (category, severity). No Drizzle, no clock side
// effects: every function takes the evaluation `Date` explicitly so the fan-out planner (and
// its tests) stay deterministic. The DB-backed dispatcher (M36-T08) loads the rows and feeds
// these in; T04 owns only the decision logic.

import type { AlertCategory, AlertSeverity, NotificationChannel } from "../interfaces/kinds";

/** In-app is the always-available floor (§2.1 principle 1): every alert delivery starts with
 *  an in-app emit, and out-of-band channels are additive, never replacements. */
export const FLOOR_CHANNEL: NotificationChannel = "in_app";

/** The §3.2 severity ladder as an ordinal, so "at/above the quiet-hours override" (§2.5) is a
 *  numeric compare rather than a scattered string switch. */
const SEVERITY_RANK: { readonly [S in AlertSeverity]: number } = {
  info: 0,
  warn: 1,
  critical: 2,
};

/** True when `severity` is at or above `floor` on the §3.2 ladder. */
export function severityAtLeast(severity: AlertSeverity, floor: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

/**
 * `user_notification_preferences.routing_map` (§3.6): category → severity → channels[]. The
 * dispatcher derives the out-of-band channel set for an alert from this map; in-app is added
 * unconditionally by the planner (the floor), so a map need not list it.
 */
export type RoutingMap = {
  readonly [C in AlertCategory]?: {
    readonly [S in AlertSeverity]?: readonly NotificationChannel[];
  };
};

/** One quiet-hours window (§3.6 quiet_hours.ranges). `start`/`end` are `HH:mm` wall-clock in
 *  the preference `tz`; a window with `start > end` wraps past midnight. */
export interface QuietHoursRange {
  readonly daysOfWeek: readonly number[]; // 0 = Sunday … 6 = Saturday
  readonly start: string; // 'HH:mm'
  readonly end: string; // 'HH:mm'
}

/** `user_notification_preferences.quiet_hours` (§3.6). `severityOverride` is the floor at/above
 *  which an alert bypasses quiet hours entirely (§2.5; default `critical`). */
export interface QuietHoursConfig {
  readonly tz: string;
  readonly ranges: readonly QuietHoursRange[];
  readonly severityOverride: AlertSeverity;
}

/** The slice of `user_notification_preferences` the fan-out planner reads (§3.6). */
export interface RecipientPreferences {
  readonly userId: string;
  readonly routingMap: RoutingMap;
  readonly quietHours: QuietHoursConfig;
  /** Vacation forwarding target (§3.6); null when not on vacation. */
  readonly vacationForwardToUserId: string | null;
  /** Bounded by a CHECK (§2.5): set iff `vacationForwardToUserId` is set, must be in the future. */
  readonly vacationUntil: Date | null;
}

/**
 * The out-of-band channels this recipient wants for `(category, severity)` (§3.6 routing_map),
 * EXCLUDING the in-app floor (the planner always adds that). Unknown category/severity → empty
 * (in-app floor still applies). Deduped, input order preserved for deterministic delivery rows.
 */
export function preferredOutOfBandChannels(
  prefs: RecipientPreferences,
  category: AlertCategory,
  severity: AlertSeverity,
): NotificationChannel[] {
  const configured = prefs.routingMap[category]?.[severity] ?? [];
  const seen = new Set<NotificationChannel>();
  const out: NotificationChannel[] = [];
  for (const ch of configured) {
    if (ch === FLOOR_CHANNEL || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

/** True when vacation forwarding is active at `at` (§2.5: target set AND `vacationUntil > now`). */
export function isVacationActive(prefs: RecipientPreferences, at: Date): boolean {
  return (
    prefs.vacationForwardToUserId !== null &&
    prefs.vacationUntil !== null &&
    prefs.vacationUntil.getTime() > at.getTime()
  );
}

const WEEKDAY_INDEX: { readonly [k: string]: number } = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The recipient's local wall clock at `at`, in their preference `tz`, as a day-of-week
 *  (0–6) + minutes-since-midnight. Uses `Intl` tz data so DST is handled correctly. */
export function localWallClock(at: Date, tz: string): { dayOfWeek: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dayOfWeek = WEEKDAY_INDEX[get("weekday")] ?? 0;
  // hour12:false can render midnight as '24' in some ICU builds — fold it back to 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { dayOfWeek, minutesOfDay: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** True when `(dayOfWeek, minutesOfDay)` falls inside the range. Same-day windows are a simple
 *  half-open `[start, end)` on a listed day; a `start > end` window wraps past midnight and is
 *  active in the late evening of a listed day or the early morning that follows it. */
function withinRange(range: QuietHoursRange, dayOfWeek: number, minutesOfDay: number): boolean {
  if (!range.daysOfWeek.includes(dayOfWeek)) return false;
  const start = toMinutes(range.start);
  const end = toMinutes(range.end);
  if (start <= end) return minutesOfDay >= start && minutesOfDay < end;
  // Wraps midnight: evening-of-listed-day OR early-morning-of-listed-day.
  return minutesOfDay >= start || minutesOfDay < end;
}

/** True when `at` lands in any quiet-hours window (§3.6 quiet_hours.ranges). */
export function isWithinQuietHours(quietHours: QuietHoursConfig, at: Date): boolean {
  if (quietHours.ranges.length === 0) return false;
  const { dayOfWeek, minutesOfDay } = localWallClock(at, quietHours.tz);
  return quietHours.ranges.some((r) => withinRange(r, dayOfWeek, minutesOfDay));
}

/**
 * Whether an alert of `severity` is suppressed out-of-band for this recipient at `at` (§2.5
 * quiet-hours override). Suppressed only when inside a quiet-hours window AND below the
 * recipient's `severityOverride` floor — an at/above-floor alert always punches through.
 * In-app is NEVER suppressed (handled by the planner); this gates out-of-band channels only.
 */
export function suppressedByQuietHours(
  prefs: RecipientPreferences,
  severity: AlertSeverity,
  at: Date,
): boolean {
  if (severityAtLeast(severity, prefs.quietHours.severityOverride)) return false;
  return isWithinQuietHours(prefs.quietHours, at);
}
