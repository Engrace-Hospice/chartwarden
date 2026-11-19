// apps/backend/src/modules/08-encounters/drafting/visit-time.ts — the instant a visit note describes the patient
// at (S1 PR C2a, VN-D11, design §3.2). Pure: the clock and the organization's time zone are arguments.
import { isValidServiceDate, localDayStart } from "../closure/clock-stamp";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VisitAsOfInput {
  /** `encounter.started_at` (EVV check-in or clinician-entered), when recorded. */
  readonly startedAt: Date | null;
  /** `encounter.clock_started_at` (ADR-0113), when stamped. */
  readonly clockStartedAt: Date | null;
  /** The org-local calendar day the visit happened on (`YYYY-MM-DD`). */
  readonly serviceDate: string;
  /** IANA zone of the organization (the one `organizationTimezone` resolves). */
  readonly orgTimeZone: string;
  readonly now: Date;
}

function assertInstant(name: string, value: Date): void {
  if (Number.isNaN(value.getTime()))
    throw new RangeError(`visitAsOf: ${name} is not a valid instant`);
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
 * The visit time: `started_at`, else `clock_started_at`, else the end of the service date in the org's zone,
 * and never later than `now` (a device clock that ran ahead, or a service date still in progress, cannot make
 * a note describe the future). Returned as an ISO-8601 instant in UTC, the form `compileDraft` and the seams take.
 */
export function visitAsOf(input: VisitAsOfInput): string {
  assertInstant("now", input.now);
  if (input.startedAt !== null) assertInstant("startedAt", input.startedAt);
  if (input.clockStartedAt !== null) assertInstant("clockStartedAt", input.clockStartedAt);
  const known =
    input.startedAt ?? input.clockStartedAt ?? endOfLocalDay(input.serviceDate, input.orgTimeZone);
  return new Date(Math.min(known.getTime(), input.now.getTime())).toISOString();
}
