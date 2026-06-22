// apps/backend/src/modules/07-care-plan/lifecycle/gate-clock.ts — M7-T07 the org-timezone, calendar-day
// clock that DERIVES the two CoP 418.56 due columns the §2.6 sign gate (overdue-gate.ts) then reads:
//   • §7.1 — the initial 5-day deadline: `care_plan.initial_due_at` = admission-activation day + 5
//     calendar days at end-of-day org-TZ (§418.54(b)). The 5-day clock starts when `m6.admission.activated`
//     is processed and the `care_plan` row is created.
//   • §7.2 — the 15-day review interval: `care_plan.next_review_due_at` = the last signed version's
//     `signed_at` day + 15 calendar days at end-of-day org-TZ (§418.56(d)).
// PURE & deterministic — every fact (the activation/sign instant, the org timezone) is injected; no IO and
// no `Date.now()`. The day math is calendar-day in the ORG's timezone then persisted as a UTC instant at
// the end-of-day boundary, exactly mirroring M6's certification window-math (D8) so the two compliance
// clocks in Wave D agree across timezones and DST boundaries. This file OWNS the column values; the cron
// scans in `../jobs` and the gate decision in `./overdue-gate` only READ them.
import type { IsoInstant, LocalDate } from "@wardenx/types";

/** Org timezone default when M2 `organization.timezone` is unset (mirrors M6 D8). */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/** §7.1 — calendar days from admission activation to the initial-care-plan deadline (§418.54(b)). */
export const INITIAL_DUE_DAYS = 5 as const;
/** §7.2 — calendar days from a signed version to the next IDG review deadline (§418.56(d)). */
export const REVIEW_INTERVAL_DAYS = 15 as const;

/**
 * §7.1/§7.2 lead time (calendar days BEFORE the due date) at which the gate cron raises the early
 * warning: the initial `5day-warning` fires at day 3 (= 5 − 2) and the `review_due` alert fires at
 * T+13 (= 15 − 2). The hard SIGN gate engages LATER, past the due date, with the grace in overdue-gate.ts.
 */
export const GATE_WARNING_LEAD_DAYS = 2 as const;

const pad = (n: number): string => String(n).padStart(2, "0");

/** The `yyyy-mm-dd` org-local calendar date of a UTC instant (the day the clock counts from). */
export function orgLocalDateOf(instant: IsoInstant, timeZone: string): LocalDate {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(Date.parse(instant)));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Add (or subtract) whole calendar days to a `yyyy-mm-dd` date; returns a `yyyy-mm-dd` date. */
export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  const dt = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** The whole-minute offset (ms) of `timeZone` at `utcMs` (`localWallClock − UTC`); Intl handles DST. */
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

/** The UTC instant for the END of calendar day `date` in `timeZone` (23:59:59.999 org-local; D8). */
export function endOfOrgDayInstant(date: LocalDate, timeZone: string): IsoInstant {
  const wallUTC = Date.parse(`${date}T23:59:59.999Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/**
 * §7.1 — compute `care_plan.initial_due_at` from the admission-activation instant: the org-local
 * activation day + 5 calendar days, at end-of-day org-TZ. The 5-day clock is a calendar-day clock, so
 * the time-of-day of activation never shortens the window.
 */
export function computeInitialDueAt(
  admissionActivatedAt: IsoInstant,
  timeZone: string = DEFAULT_ORG_TIME_ZONE,
): IsoInstant {
  const activationDay = orgLocalDateOf(admissionActivatedAt, timeZone);
  return endOfOrgDayInstant(addCalendarDays(activationDay, INITIAL_DUE_DAYS), timeZone);
}

/**
 * §7.2 — compute `care_plan.next_review_due_at` from a version's `signed_at` instant: the org-local
 * sign day + 15 calendar days, at end-of-day org-TZ. Called on every `version_signed` (initial and each
 * IDG review) so the review clock re-arms from the most recent signature.
 */
export function computeNextReviewDueAt(
  signedAt: IsoInstant,
  timeZone: string = DEFAULT_ORG_TIME_ZONE,
): IsoInstant {
  const signedDay = orgLocalDateOf(signedAt, timeZone);
  return endOfOrgDayInstant(addCalendarDays(signedDay, REVIEW_INTERVAL_DAYS), timeZone);
}
