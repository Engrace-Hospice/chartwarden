// M25 — Medicare appeal-tier deadline computation (D6, M25-F04, §1.3). PURE.
//
// The regulatory clock. Every tier's window runs from the party's RECEIPT of the prior notice, and receipt
// is presumed to be 5 calendar days after the date ON the notice unless there is evidence to the contrary:
//   - redetermination  : 120 days from receipt of the initial determination (remittance advice)  §405.942(a)
//   - reconsideration  : 180 days from receipt of the redetermination notice                      §405.962(a)
//   - alj              :  60 days from receipt of the QIC reconsideration notice                  §405.1002
//   - council          :  60 days from receipt of the ALJ decision                                §405.1102(a)
//   - federal_court    :  60 days from receipt of the Council decision                            §405.1136
// (Council → court: the presumption is stated in §405.1136; the 60 days are in §§405.1130-1134.)
//
// The anchor is therefore the NOTICE DATE (the date printed on the remittance advice / decision letter),
// not the day ChartWarden ingested the file. The last filing day is usable until it ends: the deadline is the
// last millisecond of that calendar day in `zone`. The presumption is rebuttable by documented receipt;
// that override is intentionally NOT built here (conservative: the presumed date always applies).
// A last filing day that is a weekend or US federal holiday moves BACK to the previous business day (clinical-
// billing SME decision: conservative, never later than the regulatory date). 42 CFR Part 405 has no roll-forward.
//
// Good cause for late filing is handled by the submit-late-good-cause route, not here. The `appeal.submit`
// route hard-blocks past T-0 via the `appeal_within_deadline` ABAC predicate; the cron emits T-30/14/7/1.
import type { AppealTier } from "./types";

/** Filing windows (days) per tier, counted from presumed receipt of the prior notice. */
export const TIER_WINDOW_DAYS: Record<AppealTier, number> = {
  redetermination: 120,
  reconsideration: 180,
  alj: 60,
  council: 60,
  federal_court: 60,
};

/** Receipt is presumed this many calendar days after the date on the notice (all five tiers). */
export const RECEIPT_PRESUMPTION_DAYS = 5;

/**
 * Zone used when no provider location zone is known. It is the earliest-ending US mainland zone, so it errs
 * toward alerting early. When locations are known but disagree, the earliest-ending of THEM is used instead.
 */
export const DEFAULT_DEADLINE_ZONE = "America/New_York";

/** True when `zone` is an IANA zone this runtime knows (a bad stored value must not break appeal creation). */
export function isKnownZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The deadline-alert boundaries the cron fires at (days remaining), plus the hard T-0 block. */
export const DEADLINE_ALERT_DAYS: readonly number[] = [30, 14, 7, 1];

const NOTICE_DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MS_PER_DAY = 86_400_000;

/** How a deadline was derived — shown to the user so a date is never an unexplained number. */
export interface TierDeadlineDerivation {
  readonly noticeDay: string; // YYYY-MM-DD printed on the notice
  readonly presumedReceiptOn: string; // noticeDay + RECEIPT_PRESUMPTION_DAYS
  readonly windowDays: number;
  readonly calendarLastDay: string; // presumedReceiptOn + windowDays, before any business-day roll-back
  readonly lastFilingDay: string; // calendarLastDay, moved back to a business day
  readonly deadlineAt: Date; // end of lastFilingDay in `zone`
  readonly zone: string;
}

export function parseNoticeDay(noticeDay: string): number {
  const m = NOTICE_DAY_SHAPE.exec(noticeDay);
  if (!m) throw new RangeError(`notice day must be YYYY-MM-DD, got "${noticeDay}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`notice day is not a real calendar date: "${noticeDay}"`);
  }
  return ms;
}

export function isoDay(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

const formatterByZone = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatterByZone.get(zone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  formatterByZone.set(zone, made);
  return made;
}

const nthWeekday = (y: number, month: number, weekday: number, n: number): number => {
  const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
  return Date.UTC(y, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
};
const lastMonday = (y: number, month: number): number => {
  const last = new Date(Date.UTC(y, month + 1, 0));
  return last.getTime() - ((last.getUTCDay() + 6) % 7) * MS_PER_DAY;
};

/** US federal holidays as OBSERVED (Saturday -> Friday, Sunday -> Monday) for calendar year `y`, UTC midnights. */
function observedFederalHolidays(y: number): number[] {
  const fixed = [
    [0, 1],
    [5, 19],
    [6, 4],
    [10, 11],
    [11, 25],
  ].map(([m, d]) => {
    const ms = Date.UTC(y, m!, d!);
    const dow = new Date(ms).getUTCDay();
    return dow === 6 ? ms - MS_PER_DAY : dow === 0 ? ms + MS_PER_DAY : ms;
  });
  return [
    ...fixed,
    nthWeekday(y, 0, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(y, 1, 1, 3), // Washington's Birthday
    lastMonday(y, 4), // Memorial Day
    nthWeekday(y, 8, 1, 1), // Labor Day
    nthWeekday(y, 9, 1, 2), // Columbus Day
    nthWeekday(y, 10, 4, 4), // Thanksgiving
  ];
}

function isBusinessDay(dayMs: number): boolean {
  const dow = new Date(dayMs).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const y = new Date(dayMs).getUTCFullYear();
  // A New Year's Day that falls on a Saturday is observed on 31 December of the prior year.
  return ![...observedFederalHolidays(y), ...observedFederalHolidays(y + 1)].includes(dayMs);
}

export function previousBusinessDay(dayMs: number): number {
  let ms = dayMs;
  while (!isBusinessDay(ms)) ms -= MS_PER_DAY;
  return ms;
}

/** The next business day on or after `dayMs` (milestone 12a-1: a payer path may state a forward roll). */
export function nextBusinessDay(dayMs: number): number {
  let ms = dayMs;
  while (!isBusinessDay(ms)) ms += MS_PER_DAY;
  return ms;
}

/** Milliseconds `zone` is ahead of UTC at the instant `ts` (negative west of UTC). */
function zoneOffsetMs(ts: number, zone: string): number {
  const parts = formatterFor(zone).formatToParts(new Date(ts));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallAsUtc - Math.floor(ts / 1000) * 1000;
}

/** The last millisecond (23:59:59.999) of calendar day `dayUtcMidnightMs` as seen in `zone`. */
export function endOfDayInZone(dayUtcMidnightMs: number, zone: string): Date {
  const wallEnd = dayUtcMidnightMs + MS_PER_DAY - 1;
  // Two passes settle the offset when the day contains a daylight-saving change.
  let ts = wallEnd - zoneOffsetMs(wallEnd, zone);
  ts = wallEnd - zoneOffsetMs(ts, zone);
  return new Date(ts);
}

/**
 * Derive a tier's filing deadline from the date printed on the prior notice.
 * - `redetermination`: the remittance advice date.
 * - every later tier: the prior tier's decision-letter date.
 */
export function deriveTierDeadline(
  tier: AppealTier,
  noticeDay: string,
  zones: string | readonly string[] = DEFAULT_DEADLINE_ZONE,
): TierDeadlineDerivation {
  const noticeMs = parseNoticeDay(noticeDay);
  const receiptMs = noticeMs + RECEIPT_PRESUMPTION_DAYS * MS_PER_DAY;
  const windowDays = TIER_WINDOW_DAYS[tier];
  const calendarLastMs = receiptMs + windowDays * MS_PER_DAY;
  const lastMs = previousBusinessDay(calendarLastMs);
  // Several zones: the day ends earliest in the one whose end-of-day instant comes first.
  const zoneList = Array.isArray(zones) ? zones : [zones as string];
  const ends = (zoneList.length > 0 ? zoneList : [DEFAULT_DEADLINE_ZONE]).map((zone) => ({
    zone,
    at: endOfDayInZone(lastMs, zone),
  }));
  const first = ends.reduce((a, b) => (b.at.getTime() < a.at.getTime() ? b : a));
  return {
    noticeDay,
    presumedReceiptOn: isoDay(receiptMs),
    windowDays,
    calendarLastDay: isoDay(calendarLastMs),
    lastFilingDay: isoDay(lastMs),
    deadlineAt: first.at,
    zone: first.zone,
  };
}

/** Compute a tier's filing deadline instant (end of the last filing day). See `deriveTierDeadline`. */
export function computeTierDeadline(
  tier: AppealTier,
  noticeDay: string,
  zones: string | readonly string[] = DEFAULT_DEADLINE_ZONE,
): Date {
  return deriveTierDeadline(tier, noticeDay, zones).deadlineAt;
}

/**
 * The calendar day (YYYY-MM-DD) a timestamp carries when it stands for a date printed on a notice. Notice
 * dates arrive as timestamps at UTC midnight (835 production date, decision-letter date), so the UTC date
 * is the printed date. A timestamp with a real time of day can differ from the printed local date by a day;
 * callers that hold a true date should pass it directly.
 */
export function noticeDayOf(stamp: Date): string {
  return stamp.toISOString().slice(0, 10);
}

/** The tier that follows `tier` in the Medicare hierarchy, or null at the terminal (federal_court). */
export function nextTier(tier: AppealTier): AppealTier | null {
  const order: AppealTier[] = [
    "redetermination",
    "reconsideration",
    "alj",
    "council",
    "federal_court",
  ];
  const i = order.indexOf(tier);
  return i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
}

/** Whole days remaining until the deadline (may be negative once past). */
export function daysUntilDeadline(deadlineAt: Date, now: Date): number {
  return Math.ceil((deadlineAt.getTime() - now.getTime()) / 86_400_000);
}

/** Fail-closed deadline gate — the truth behind the `appeal_within_deadline` ABAC predicate (D6/D7). */
export function isWithinDeadline(deadlineAt: Date, now: Date): boolean {
  return now.getTime() <= deadlineAt.getTime();
}

/**
 * Which alert boundary (if any) `now` has just crossed for a deadline — used by the deadline cron to emit
 * one M36 alert per boundary. Returns the largest threshold whose window the remaining days fall within,
 * or null when more than 30 days remain (and 0 is represented by the hard T-0 block, not an alert here).
 */
export function deadlineAlertBoundary(deadlineAt: Date, now: Date): number | null {
  // End-of-day deadlines make the ceil'd day count 0 for up to a day after T-0; past is past.
  if (now.getTime() > deadlineAt.getTime()) return null;
  const remaining = daysUntilDeadline(deadlineAt, now);
  // The active boundary is the TIGHTEST threshold the remaining days still fall within (e.g. 7 days
  // remaining → T-7, not T-30). Iterate ascending and return the first threshold >= remaining.
  const ascending = [...DEADLINE_ALERT_DAYS].sort((a, b) => a - b);
  for (const t of ascending) {
    if (remaining <= t) return t;
  }
  return null;
}
