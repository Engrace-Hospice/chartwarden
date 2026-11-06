// apps/backend/src/modules/35-subscription/pricing/statement-period.ts — the CALENDAR of a statement (slice 2). PURE: no IO, no clock.
//
// A statement is one UTC calendar month. Two questions are answered here and nowhere else:
//
//   WHEN IS A MONTH CLOSED?  `isFinalizable`: month end + STATEMENT_FINALIZE_GRACE_DAYS. Money is dated by its EFT effective date (BPR16)
//   and an 835 dated the 31st routinely arrives on the 2nd, so a statement finalized at midnight would under-bill. Money that posts AFTER
//   the grace is never lost and never re-bills the closed month: it rides the next open statement as a prior-period line.
//
//   HOW MANY DAYS OF A MONTH WAS THE SUBSCRIPTION LIVE?  `daysLiveInMonth`. "Live" is a set of time windows: from GO-LIVE (the instant
//   the tenant became active) until the subscription ENDED (canceled), minus every PAUSE. A day counts when the subscription was live at
//   ANY instant of that UTC day. So the go-live day counts in full (go-live on the 1st is a whole month, on the 30th of a 30-day month
//   it is one day) and so does the day a subscription was canceled or paused or resumed (the tenant used part of it). The platform fee
//   and the plan minimum are charged by days live / days in the month (the pure `prorateCents`, half up to the cent).
import { toBillingYearMonth } from "@chartwarden/subscription-billing";

export const DAY_MS = 86_400_000;
/** How long after a month ends its statement stays a draft: late-posted remittances dated inside the month still count. */
export const STATEMENT_FINALIZE_GRACE_DAYS = 5;

export interface MonthWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface MonthPeriod extends MonthWindow {
  readonly key: string;
  readonly days: number;
}

/** The UTC calendar month containing `at`. */
export function calendarMonthOf(at: Date): MonthPeriod {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return {
    start,
    end,
    key: toBillingYearMonth(start),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS),
  };
}

export const previousCalendarMonth = (period: MonthPeriod): MonthPeriod =>
  calendarMonthOf(new Date(period.start.getTime() - 1));

export const nextCalendarMonth = (period: MonthPeriod): MonthPeriod => calendarMonthOf(period.end);

/** True once a month may be finalized: its end plus the grace has passed. */
export const isFinalizable = (period: MonthPeriod, at: Date): boolean =>
  at.getTime() >= period.end.getTime() + STATEMENT_FINALIZE_GRACE_DAYS * DAY_MS;

/** Every calendar month from the one containing `from` through the one containing `to`, oldest first. */
export function monthsFromThrough(from: Date, to: Date): MonthPeriod[] {
  const last = calendarMonthOf(to);
  const months: MonthPeriod[] = [];
  for (
    let month = calendarMonthOf(from);
    month.start <= last.start;
    month = nextCalendarMonth(month)
  ) {
    months.push(month);
  }
  return months;
}

/** A half-open window of instants, in epoch milliseconds; `until` is `Infinity` for a window with no end. */
export interface LiveWindow {
  readonly from: number;
  readonly until: number;
}

export interface LifetimeFacts {
  /** The instant the tenant went live (tenant activation), or later if the subscription started after it. */
  readonly liveFrom: Date;
  /** The instant the subscription was canceled, else null. */
  readonly endedAt: Date | null;
  /** Paused intervals (`to` null = still paused). */
  readonly pauses: readonly { readonly from: Date; readonly to: Date | null }[];
}

const subtract = (windows: readonly LiveWindow[], cut: LiveWindow): LiveWindow[] =>
  windows.flatMap((w) => {
    if (cut.until <= w.from || cut.from >= w.until) return [w];
    const kept: LiveWindow[] = [];
    if (cut.from > w.from) kept.push({ from: w.from, until: cut.from });
    if (cut.until < w.until) kept.push({ from: cut.until, until: w.until });
    return kept;
  });

/** The windows in which the subscription is live and billable: go-live to end, with every pause taken out. */
export function liveWindowsOf(facts: LifetimeFacts): LiveWindow[] {
  const until = facts.endedAt ? facts.endedAt.getTime() : Number.POSITIVE_INFINITY;
  let windows: LiveWindow[] =
    until > facts.liveFrom.getTime() ? [{ from: facts.liveFrom.getTime(), until }] : [];
  for (const pause of facts.pauses) {
    windows = subtract(windows, {
      from: pause.from.getTime(),
      until: pause.to ? pause.to.getTime() : Number.POSITIVE_INFINITY,
    });
  }
  return windows;
}

/** How many UTC days of the month the subscription was live at ANY instant of (see the file header). */
export function daysLiveInMonth(period: MonthPeriod, windows: readonly LiveWindow[]): number {
  let days = 0;
  for (let i = 0; i < period.days; i++) {
    const dayStart = period.start.getTime() + i * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    if (windows.some((w) => w.from < dayEnd && w.until > dayStart)) days += 1;
  }
  return days;
}
