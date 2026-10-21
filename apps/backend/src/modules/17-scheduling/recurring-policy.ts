// apps/backend/src/modules/17-scheduling/recurring-policy.ts — GAP-026: validate and map the
// POST /recurring-visits body onto the `recurring_visit` policy columns. The route used to forward only the
// RRULE and the service defaulted the window to 09:00-10:00 UTC; the client's window, timezone, dates, count,
// byday and address are now authoritative (and validated here, once, for any caller of the service).
import { type ParsedRrule, parseRrule } from "@chartwarden/scheduling";
import { ValidationError } from "@chartwarden/types";

export interface RecurringPolicyFields {
  readonly rrule: string;
  readonly timeOfDayStart: string;
  readonly timeOfDayEnd: string;
  readonly timeZone: string;
  readonly startDate: string;
  readonly endDate?: string;
  readonly count?: number;
  readonly byday?: readonly string[];
  readonly patientAddressId?: string;
}

export interface RecurringPolicyColumns {
  readonly rrule: string;
  readonly timeOfDayStart: string;
  readonly timeOfDayEnd: string;
  readonly timeZone: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly count: number | null;
  readonly byday: string[] | null;
  readonly patientAddressId: string | null;
}

const MINUTES_PER_HOUR = 60;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function fail(field: string, message: string): never {
  throw new ValidationError(message, [{ field, code: "INVALID", message }]);
}

function minutesOf(field: string, hhmm: string): number {
  const m = TIME_OF_DAY.exec(hhmm);
  if (!m) return fail(field, `${field} must be a valid 24h HH:MM time`);
  return Number(m[1]) * MINUTES_PER_HOUR + Number(m[2]);
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** Throws a {@link ValidationError} (or the scheduling RRULE error) when the policy fields are unusable. */
export function assertRecurringPolicyValid(input: RecurringPolicyFields): void {
  const rule = parseRrule(input.rrule);
  if (input.endDate !== undefined && input.count !== undefined) {
    fail("count", "a recurring policy takes endDate or count, not both");
  }
  if (!isKnownTimeZone(input.timeZone)) fail("timeZone", "timeZone is not a known IANA zone");
  const start = minutesOf("timeOfDayStart", input.timeOfDayStart);
  const end = minutesOf("timeOfDayEnd", input.timeOfDayEnd);
  if (end <= start) fail("timeOfDayEnd", "timeOfDayEnd must be after timeOfDayStart");
  if (input.endDate !== undefined && input.endDate < input.startDate) {
    fail("endDate", "endDate must not be before startDate");
  }
  if (input.byday !== undefined && !sameSet(input.byday, rule.byDay)) {
    fail("byday", "byday must match the RRULE BYDAY");
  }
}

/** The stored columns for a validated policy; nothing is defaulted. */
export function toRecurringPolicyColumns(input: RecurringPolicyFields): RecurringPolicyColumns {
  return {
    rrule: input.rrule,
    timeOfDayStart: input.timeOfDayStart,
    timeOfDayEnd: input.timeOfDayEnd,
    timeZone: input.timeZone,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    count: input.count ?? null,
    byday: input.byday ? [...input.byday] : null,
    patientAddressId: input.patientAddressId ?? null,
  };
}

/**
 * The rule the materializer enumerates for a stored policy: the RRULE, with the policy's own `count` column
 * as the terminator when the RRULE carries neither COUNT nor UNTIL.
 */
export function ruleForPolicy(policy: {
  readonly rrule: string;
  readonly count: number | null;
}): ParsedRrule {
  const rule = parseRrule(policy.rrule);
  if (rule.count !== null || rule.until !== null || policy.count === null) return rule;
  return { ...rule, count: policy.count };
}
