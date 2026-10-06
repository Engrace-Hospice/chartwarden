// apps/backend/src/modules/06-admission/certification/window-math.ts — M6-T08 the org-timezone,
// calendar-day window math (§7.3–7.5; D8). PURE: every compliance/window clock in M6 is calendar-day
// based and computed in the ORG's timezone, then persisted as an instant at the boundary moment
// (23:59:59.999 org-TZ for "end of day"; D8). This is the single source of truth for the two §7.3/§7.4
// deadlines the slice and the screens key off:
//   • D4  — late-CTI written-cert deadline = period_start + 2 calendar days at 23:59 org-TZ (§7.3).
//   • CMS 418.22 — the F2F window = [period_start − 30, period_start] (§7.4 W-F2F-01; the period's first day is
//     timely per MBPM ch. 9 §20.1(5)(a)).
// No IO and no `Date.now()`: every fact (the period start date, the org timezone, the "as of" instant
// for an overdue check) is passed in, so the math is deterministic across timezones and DST boundaries.
import type { LocalDate } from "@wardenx/types";

/** Org timezone default when M2 `organization.timezone` is unset (D8). */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/** Whole calendar days CMS 418.22 spans the F2F window over (§7.4 / R-F2F-02): 30 days before through the
 *  period's first day (MBPM ch. 9 §20.1(5)(a) — an encounter on the first day "is still considered timely"). */
export const F2F_PRIOR_WINDOW = {
  earliestDaysBefore: 30,
  latestDaysBefore: 0,
} as const;

/** Calendar days the oral-then-written CTI path allows before the written cert is overdue (D4). */
export const WRITTEN_CERT_DEADLINE_DAYS = 2 as const;

/**
 * Operational SLA requested for a hospice physician to sign a newly assigned CTI.
 *
 * This is deliberately separate from WRITTEN_CERT_DEADLINE_DAYS:
 * - WRITTEN_CERT_DEADLINE_DAYS = regulatory oral→written certification path
 * - CTI_SIGNATURE_WINDOW_DAYS = WardenX operational signature SLA
 */
export const CTI_SIGNATURE_WINDOW_DAYS = 3 as const;

/**
 * Compute the CTI hospice-physician signature deadline.
 *
 * The current workflow begins the SLA when the CTI is drafted/assigned.
 * This is an exact 72-hour window rather than the separate CMS
 * oral→written certification deadline.
 */
export function computeCtiSignatureDueAt(signatureRequestedAt: Date): string {
  return new Date(
    signatureRequestedAt.getTime() + CTI_SIGNATURE_WINDOW_DAYS * 86_400_000,
  ).toISOString();
}

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
 * offset is the clean zone offset (no sub-minute drift from the source instant's seconds/ms). Uses
 * `Intl` (ICU ships with the runtime) so DST is handled exactly.
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
  const localMinute = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
  );
  return localMinute - Math.floor(utcMs / 60_000) * 60_000;
}

/**
 * The org-local calendar date (`yyyy-mm-dd`) of the instant `instant` in `timeZone` (D8 — "stored
 * `*_date` fields are the org-local calendar date"). Used to classify a signature as same-day/late
 * against a period start date.
 */
export function localDateOfInstant(instant: string, timeZone: string): LocalDate {
  const utcMs = Date.parse(instant);
  return toLocalDate(new Date(utcMs + tzOffsetMs(utcMs, timeZone)));
}

/**
 * The UTC instant for the END of calendar day `date` in `timeZone` (23:59:59.999 org-local; D8). The
 * zone offset is resolved at the end-of-day wall instant (past any early-morning DST transition) and
 * applied once, preserving the millisecond precision of the boundary moment.
 */
export function endOfOrgDayInstant(date: LocalDate, timeZone: string): string {
  // The wall-clock instant 23:59:59.999 on `date`, treated as if it were UTC (the offset is then
  // applied to land the true UTC instant).
  const wallUTC = Date.parse(`${date}T23:59:59.999Z`);
  return new Date(wallUTC - tzOffsetMs(wallUTC, timeZone)).toISOString();
}

/**
 * D4 — the written-cert deadline for a late (oral-then-written) CTI: `period_start + 2 calendar days`
 * at 23:59 in the org's timezone, returned as a UTC instant (§7.3 late-cert path). If the written
 * cert is not captured by this instant, the caller fires `m6.compliance.window.overdue`.
 */
export function computeWrittenCertDeadline(periodStartDate: LocalDate, timeZone: string): string {
  return endOfOrgDayInstant(addCalendarDays(periodStartDate, WRITTEN_CERT_DEADLINE_DAYS), timeZone);
}

/** Has `asOfInstant` passed the written-cert `deadlineInstant`? (strictly after → overdue). */
export function isWrittenCertOverdue(deadlineInstant: string, asOfInstant: string): boolean {
  return Date.parse(asOfInstant) > Date.parse(deadlineInstant);
}

/** The CMS 418.22 F2F prior-to window (§7.4 W-F2F-01): inclusive org-local dates + the end instant. */
export interface F2fWindow {
  readonly windowStart: LocalDate;
  readonly windowEnd: LocalDate;
  readonly windowEndInstant: string;
}

/** Compute the F2F window `[period_start − 30, period_start]` in org-local calendar days (§7.4). */
export function computeF2fWindow(periodStartDate: LocalDate, timeZone: string): F2fWindow {
  const windowStart = addCalendarDays(periodStartDate, -F2F_PRIOR_WINDOW.earliestDaysBefore);
  const windowEnd = addCalendarDays(periodStartDate, -F2F_PRIOR_WINDOW.latestDaysBefore);
  return {
    windowStart,
    windowEnd,
    windowEndInstant: endOfOrgDayInstant(windowEnd, timeZone),
  };
}

/** W-F2F-01: is the scheduled F2F date inside the window? (`yyyy-mm-dd` lexical compare is date order). */
export function isF2fScheduledWithinWindow(scheduledDate: LocalDate, window: F2fWindow): boolean {
  return scheduledDate >= window.windowStart && scheduledDate <= window.windowEnd;
}

/** F2F window monitor verdict (§7.4 W-F2F-04): `attested` closes it; an unattested past-end is `missed`. */
export type F2fWindowStatus = "open" | "missed" | "attested";

/**
 * W-F2F-04 — the window-monitor decision: an attested F2F closes the window; otherwise, once the org-
 * local day passes `windowEnd`, the window is `missed` (the caller emits `m6.f2f.window_missed`).
 */
export function decideF2fWindowStatus(input: {
  readonly today: LocalDate;
  readonly window: F2fWindow;
  readonly attested: boolean;
}): F2fWindowStatus {
  if (input.attested) return "attested";
  return input.today > input.window.windowEnd ? "missed" : "open";
}

// ── 42 CFR 418.54 assessment clocks ──────────────────────────────────────────────────────────────────

/** 42 CFR 418.54(a) — the RN initial assessment is due "within 48 hours after the election". */
export const INITIAL_ASSESSMENT_HOURS = 48;
/** The initial assessment's 48 hours as a calendar-date bound (the latest DATE 48 hours can reach). */
export const INITIAL_ASSESSMENT_DAYS = 2;
/**
 * 42 CFR 418.54(b) — the IDG completes the comprehensive assessment "no later than 5 calendar days after the
 * election". CMS SOM Appendix M (L523) counts the election date as DAY 0: elected Wednesday ⇒ Monday is day 5,
 * the last timely day. So the due DATE is `election + 5`, not `election + 4`.
 */
export const COMPREHENSIVE_ASSESSMENT_DAYS = 5;

/** The two §418.54 window kinds whose deadline is anchored on the election. */
export type AssessmentWindowKind = "initial_assessment_48h" | "comprehensive_assessment_5d";

export function isAssessmentWindowKind(kind: string): kind is AssessmentWindowKind {
  return kind === "initial_assessment_48h" || kind === "comprehensive_assessment_5d";
}

/** The comprehensive assessment's last timely org-local DATE: election date (day 0) + 5 calendar days. */
export function comprehensiveAssessmentDueOn(electionDate: LocalDate): LocalDate {
  return addCalendarDays(electionDate, COMPREHENSIVE_ASSESSMENT_DAYS);
}

/**
 * The `compliance_window.must_complete_by` instant of a §418.54 assessment window anchored at the election
 * instant `electedAt`:
 *   • `initial_assessment_48h` — exactly 48 hours after the election (418.54(a) is an hour clock);
 *   • `comprehensive_assessment_5d` — 23:59:59.999 org-local on election date + 5 (418.54(b) is a calendar-day
 *     clock with the election date as day 0, so the whole of day 5 is on time and day 6 is late).
 */
export function computeAssessmentWindowDeadline(
  kind: AssessmentWindowKind,
  electedAt: Date,
  timeZone: string,
): Date {
  if (kind === "initial_assessment_48h")
    return new Date(electedAt.getTime() + INITIAL_ASSESSMENT_HOURS * 3_600_000);
  const electionDate = localDateOfInstant(electedAt.toISOString(), timeZone);
  return new Date(endOfOrgDayInstant(comprehensiveAssessmentDueOn(electionDate), timeZone));
}
