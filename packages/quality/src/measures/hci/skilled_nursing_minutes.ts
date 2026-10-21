// @chartwarden/quality — the skilled-nursing-minute reduction behind HCI indicators 8 and 9 (§1.1). Pure. No IO.
//
// The M30 worker reads M6's level-of-care day spans (`LevelOfCarePeriodReader.levelOfCareDaySpans`) and M8's
// per-(admission, service date) skilled-nursing totals (`SignedEncountersReader.skilledNursingDayTotalsForOrg`)
// for the window and hands both lists here. This returns the three totals the two CMS definitions need:
//
//   - Indicator 8, "Skilled Nursing Care Minutes per Routine Home Care (RHC) Day": the MEAN — total
//     skilled-nursing minutes delivered on RHC days ÷ total RHC days.
//   - Indicator 9, "Skilled Nursing Minutes on Weekends": the SHARE of those same minutes (skilled nursing on
//     RHC days) delivered on a Saturday or Sunday.
//
// Dates are `yyyy-mm-dd` calendar days; spans and the window are half-open `[from, to)`. "Skilled nursing"
// (signed RN/LPN encounters) and the minute arithmetic are M8's; a visit with no recorded start/end bracket
// arrives as a day total of 0 minutes and so adds nothing to either indicator (it still counts as a VISIT
// for indicator 2, which reads the `visits` field this reduction ignores).

/** The `level_of_care` value whose days make up both indicators' population. */
export const HCI_ROUTINE_HOME_CARE_LEVEL = "routine_home_care";

/** One level-of-care span on one admission (the M6 `LevelOfCareDaySpan` shape, `to` exclusive). */
export interface HciLevelOfCareSpan {
  readonly admissionId: string;
  readonly levelOfCare: string;
  readonly from: string;
  readonly to: string;
}

/** One (admission, service date) skilled-nursing total (the M8 `SkilledNursingDayTotal` shape). */
export interface HciSkilledNursingDayMinutes {
  readonly admissionId: string;
  readonly serviceDate: string;
  /** Summed recorded minutes that day; 0 when no encounter that day carried a start/end bracket. */
  readonly minutes: number;
}

/** The totals {@link skilledNursingMinutesOnRhcDays} returns. */
export interface HciSkilledNursingMinuteTotals {
  /** Distinct (admission, calendar day) pairs at routine home care inside the window — indicator 8's denominator. */
  readonly totalRhcDays: number;
  /** Skilled-nursing minutes delivered on those days — indicator 8's numerator, indicator 9's denominator. */
  readonly skilledNursingMinutes: number;
  /** Of those minutes, the ones delivered on a Saturday or Sunday — indicator 9's numerator. */
  readonly weekendSkilledNursingMinutes: number;
}

const MS_PER_DAY = 86_400_000;
const dayNumber = (isoDay: string): number =>
  Math.floor(Date.parse(`${isoDay.slice(0, 10)}T00:00:00.000Z`) / MS_PER_DAY);

/** Saturday or Sunday, for a day number (day 0 = 1970-01-01, a Thursday). */
const isWeekendDay = (day: number): boolean => {
  const dow = new Date(day * MS_PER_DAY).getUTCDay();
  return dow === 0 || dow === 6;
};

/**
 * HCI indicators 8 and 9 — routine-home-care days in `[window.from, window.to)`, and the skilled-nursing
 * minutes delivered on them (all, and on weekends).
 *
 * - Each span is clipped to the window, so a level of care that began before it or runs past it contributes
 *   only its in-window days.
 * - A day is counted ONCE per admission even if two RHC spans on that admission touch it (a re-entered
 *   level-of-care row must not inflate the denominator).
 * - Minutes count only when the (admission, day) is itself an RHC day in the window — a visit on a general
 *   inpatient, respite or continuous-home-care day, or on a day outside the window, is not in either
 *   indicator's population.
 */
export function skilledNursingMinutesOnRhcDays(
  spans: readonly HciLevelOfCareSpan[],
  dayMinutes: readonly HciSkilledNursingDayMinutes[],
  window: { readonly from: string; readonly to: string },
): HciSkilledNursingMinuteTotals {
  const windowStart = dayNumber(window.from);
  const windowEnd = dayNumber(window.to);

  const rhcDaysByAdmission = new Map<string, Set<number>>();
  for (const span of spans) {
    if (span.levelOfCare !== HCI_ROUTINE_HOME_CARE_LEVEL) continue;
    const start = Math.max(dayNumber(span.from), windowStart);
    const end = Math.min(dayNumber(span.to), windowEnd);
    if (end <= start) continue;
    let days = rhcDaysByAdmission.get(span.admissionId);
    if (days === undefined) {
      days = new Set<number>();
      rhcDaysByAdmission.set(span.admissionId, days);
    }
    for (let day = start; day < end; day += 1) days.add(day);
  }

  let totalRhcDays = 0;
  for (const days of rhcDaysByAdmission.values()) totalRhcDays += days.size;

  let skilledNursingMinutes = 0;
  let weekendSkilledNursingMinutes = 0;
  for (const d of dayMinutes) {
    if (d.minutes <= 0) continue;
    const day = dayNumber(d.serviceDate);
    if (!rhcDaysByAdmission.get(d.admissionId)?.has(day)) continue;
    skilledNursingMinutes += d.minutes;
    if (isWeekendDay(day)) weekendSkilledNursingMinutes += d.minutes;
  }

  return { totalRhcDays, skilledNursingMinutes, weekendSkilledNursingMinutes };
}
