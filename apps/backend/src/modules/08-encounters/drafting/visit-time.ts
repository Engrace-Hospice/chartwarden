// apps/backend/src/modules/08-encounters/drafting/visit-time.ts — the instant a visit note describes the patient
// at (S1 PR C2a, VN-D11, design §3.2). Pure: the clock and the organization's time zone are arguments.
import { isValidServiceDate, localDayStart } from "../closure/clock-stamp";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VisitAsOfInput {
  /** The org-local calendar day the visit happened on (`YYYY-MM-DD`). */
  readonly serviceDate: string;
  /** IANA zone of the organization (the one `organizationTimezone` resolves). */
  readonly orgTimeZone: string;
  readonly now: Date;
}

/** The last millisecond of an org-local calendar day: the start of the next local day, minus 1 ms. */
function endOfLocalDay(serviceDate: string, timeZone: string): Date {
  if (!isValidServiceDate(serviceDate)) {
    throw new RangeError(`visitAsOf: '${serviceDate}' is not a YYYY-MM-DD date`);
  }
  const nextDay = new Date(Date.parse(`${serviceDate}T00:00:00.000Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  return new Date(localDayStart(nextDay, timeZone).getTime() - 1);
}

/**
 * The visit time: the last millisecond of the service date in the organization's zone, and never later than `now`.
 * The whole service date counts, so a clinician documenting after checkout, or later that day, still gets the
 * visit's own vitals, scores and medication changes; a note written days late does not pull in the days since;
 * a service date still in progress is capped at `now`, so a note never describes the future. Neither
 * `started_at` nor `clock_started_at` matters here. Returned as an ISO-8601 instant in UTC, the form
 * `compileDraft` and the seams take.
 */
export function visitAsOf(input: VisitAsOfInput): string {
  if (Number.isNaN(input.now.getTime())) {
    throw new RangeError("visitAsOf: now is not a valid instant");
  }
  const dayEnd = endOfLocalDay(input.serviceDate, input.orgTimeZone);
  return new Date(Math.min(dayEnd.getTime(), input.now.getTime())).toISOString();
}
