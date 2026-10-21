// @chartwarden/quality — the pure DAY reductions behind SSVI metrics 3 and 7. Pure. No IO.
//
// Both are defined over routine-home-care DAYS joined to skilled-VISIT days, which no single module holds: M6
// owns the level-of-care spans, M8 owns which days a skilled discipline (RN, LPN, MSW) visited. The worker reads
// both aggregates and reduces them here (the HCI 8/9 posture, `skilledNursingMinutesOnRhcDays`).
import {
  HCI_ROUTINE_HOME_CARE_LEVEL,
  type HciLevelOfCareSpan,
} from "../hci/skilled_nursing_minutes";

/** One (admission, service date) with a signed skilled visit (the M8 `SkilledVisitDay` shape). */
export interface SsviSkilledVisitDay {
  readonly admissionId: string;
  readonly serviceDate: string;
}

/** One decedent for metric 3 (the M6 death census, reduced to the join key + the date of death). */
export interface SsviDecedent {
  readonly admissionId: string;
  /** `yyyy-mm-dd` date of death. */
  readonly deathDate: string;
}

const MS_PER_DAY = 86_400_000;
const dayNumber = (isoDay: string): number =>
  Math.floor(Date.parse(`${isoDay.slice(0, 10)}T00:00:00.000Z`) / MS_PER_DAY);
const isWeekendDay = (day: number): boolean => {
  const dow = new Date(day * MS_PER_DAY).getUTCDay();
  return dow === 0 || dow === 6;
};

/** RHC day numbers per admission inside `[from, to)` (spans clipped; a day counted once per admission). */
function rhcDaysByAdmission(
  spans: readonly HciLevelOfCareSpan[],
  window?: { readonly from: string; readonly to: string },
): Map<string, Set<number>> {
  const lo = window ? dayNumber(window.from) : Number.NEGATIVE_INFINITY;
  const hi = window ? dayNumber(window.to) : Number.POSITIVE_INFINITY;
  const out = new Map<string, Set<number>>();
  for (const span of spans) {
    if (span.levelOfCare !== HCI_ROUTINE_HOME_CARE_LEVEL) continue;
    const start = Math.max(dayNumber(span.from), lo);
    const end = Math.min(dayNumber(span.to), hi);
    if (end <= start) continue;
    let days = out.get(span.admissionId);
    if (days === undefined) {
      days = new Set<number>();
      out.set(span.admissionId, days);
    }
    for (let day = start; day < end; day += 1) days.add(day);
  }
  return out;
}

function visitDaySet(visits: readonly SsviSkilledVisitDay[]): Set<string> {
  return new Set(visits.map((v) => `${v.admissionId}|${dayNumber(v.serviceDate)}`));
}

/**
 * SSVI metric 7 — RHC days in `[window.from, window.to)` (denominator), and the Saturday/Sunday RHC days among
 * them with at least one skilled visit (numerator). CMS divides by ALL RHC days, not weekend days.
 */
export function ssviWeekendRhcDaysWithSkilledVisit(
  spans: readonly HciLevelOfCareSpan[],
  visits: readonly SsviSkilledVisitDay[],
  window: { readonly from: string; readonly to: string },
): { readonly totalRhcDays: number; readonly weekendRhcDaysWithSkilledVisit: number } {
  const rhc = rhcDaysByAdmission(spans, window);
  const visited = visitDaySet(visits);
  let totalRhcDays = 0;
  let weekendRhcDaysWithSkilledVisit = 0;
  for (const [admissionId, days] of rhc) {
    totalRhcDays += days.size;
    for (const day of days) {
      if (isWeekendDay(day) && visited.has(`${admissionId}|${day}`))
        weekendRhcDaysWithSkilledVisit += 1;
    }
  }
  return { totalRhcDays, weekendRhcDaysWithSkilledVisit };
}

/**
 * SSVI metric 3 — decedents whose day of death AND the day before were both RHC (denominator), and those with
 * a skilled visit on either day (numerator).
 *
 * ★ Day-of-death rule (flagged): a level-of-care span is half-open and may END on the discharge date, so the day
 * of death is often not inside any span. When NO span of any level covers the death date, the level of the day
 * before carries to the death date (the patient did not change level by dying). A death date covered by a
 * non-RHC span (GIP, CHC, respite) is not RHC.
 */
export function ssviLastTwoDaysRhcWithVisit(
  decedents: readonly SsviDecedent[],
  spans: readonly HciLevelOfCareSpan[],
  visits: readonly SsviSkilledVisitDay[],
): {
  readonly decedentsWithLastTwoDaysRhc: number;
  readonly decedentsWithSkilledVisitInLastTwoDays: number;
} {
  const rhc = rhcDaysByAdmission(spans);
  const anyLevelCovers = (admissionId: string, day: number): boolean =>
    spans.some(
      (s) => s.admissionId === admissionId && dayNumber(s.from) <= day && day < dayNumber(s.to),
    );
  const visited = visitDaySet(visits);
  let decedentsWithLastTwoDaysRhc = 0;
  let decedentsWithSkilledVisitInLastTwoDays = 0;
  for (const d of decedents) {
    const death = dayNumber(d.deathDate);
    const before = death - 1;
    const days = rhc.get(d.admissionId);
    const dayBeforeRhc = days?.has(before) === true;
    const deathDayRhc =
      days?.has(death) === true || (dayBeforeRhc && !anyLevelCovers(d.admissionId, death));
    if (!dayBeforeRhc || !deathDayRhc) continue;
    decedentsWithLastTwoDaysRhc += 1;
    if (visited.has(`${d.admissionId}|${death}`) || visited.has(`${d.admissionId}|${before}`))
      decedentsWithSkilledVisitInLastTwoDays += 1;
  }
  return { decedentsWithLastTwoDaysRhc, decedentsWithSkilledVisitInLastTwoDays };
}
