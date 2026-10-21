// @chartwarden/scheduling — §2.2.3 D4 / §7.7 recurring-visit RRULE materializer + discontinuation (M17-T03).
// Pure, IO-free, `Date.now()`-free.
//
// The RFC 5545 RRULE subset (D4): `FREQ ∈ {DAILY, WEEKLY}` with `BYDAY` (WEEKLY only), `INTERVAL`, and
// exactly one of `COUNT` / `UNTIL` as the terminator. `MONTHLY` / `YEARLY` / `BYSETPOS` / `BYMONTHDAY` /
// `BYWEEKNO` / `BYHOUR` are rejected — hospice cadence operates in sub-month windows. The `materialize-
// recurring` cron (M17-T08) materializes a rolling 90-day horizon of `visit` rows in `proposed` state from
// each active policy; materialization is idempotent on `(recurring_visit_id, service_date)` — re-running
// produces the identical date set, so the cron upserts. This module is the deterministic, DST-exact heart
// of that cron: it parses+validates the rule and enumerates the org-local occurrence dates + their
// `scheduled_started_at` / `scheduled_ended_at` instants. The actual `visit` row genesis (and the
// `visit_state_history` row) is `planVisitProposed` (visit-machine).
import type { IsoDate, IsoInstant, RruleByDay } from "@chartwarden/types";
import { RRULE_BYDAY, SUPPORTED_RRULE_FREQ, type SupportedRruleFreq } from "../rrule";
import type { SchedulingSideEffect } from "./effects";
import { SchedulingStateError, require_ } from "./errors";
import {
  addCalendarDays,
  atOrgLocalTime,
  calendarDaysBetween,
  dayOfWeekIndex,
  weekdayCode,
} from "./time";

/** The §2.2.3 / §7.7 default rolling materialization horizon (days). */
export const MATERIALIZE_HORIZON_DAYS = 90;

/** A parsed + validated RRULE in the locked subset (the output of {@link parseRrule}). */
export interface ParsedRrule {
  readonly freq: SupportedRruleFreq;
  /** `INTERVAL` (default 1; ≥ 1). */
  readonly interval: number;
  /** `BYDAY` weekday set (WEEKLY only; empty for DAILY). */
  readonly byDay: readonly RruleByDay[];
  /** `COUNT` total-occurrence cap (mutually exclusive with `until`). */
  readonly count: number | null;
  /** `UNTIL` last-occurrence date (inclusive; mutually exclusive with `count`). */
  readonly until: IsoDate | null;
}

const BYDAY_SET = new Set<string>(RRULE_BYDAY);
const ALLOWED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);

/** Parse the RFC 5545 `UNTIL` value (`YYYYMMDD` or `YYYYMMDDThhmmssZ`) into an `IsoDate` (date portion). */
function parseUntil(raw: string): IsoDate {
  const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(raw);
  if (!m)
    throw new SchedulingStateError("RECURRENCE_INVALID_RRULE", `malformed UNTIL value '${raw}'`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Parse + validate an RRULE string against the locked §2.2.5 subset. Throws {@link SchedulingStateError}:
 * `RECURRENCE_FREQUENCY_NOT_SUPPORTED` for a non-{DAILY,WEEKLY} `FREQ`, `RECURRENCE_TERMINATOR_CONFLICT`
 * when both `COUNT` and `UNTIL` are present, `RECURRENCE_BYDAY_INVALID` for an empty/invalid WEEKLY
 * `BYDAY` (or a `BYDAY` on a DAILY rule), and `RECURRENCE_INVALID_RRULE` for anything else malformed or
 * outside the subset.
 */
export function parseRrule(rrule: string): ParsedRrule {
  const parts = new Map<string, string>();
  for (const segment of rrule.trim().split(";")) {
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    if (eq < 0)
      throw new SchedulingStateError(
        "RECURRENCE_INVALID_RRULE",
        `malformed RRULE segment '${segment}'`,
      );
    const key = segment.slice(0, eq).toUpperCase();
    if (!ALLOWED_KEYS.has(key)) {
      throw new SchedulingStateError(
        "RECURRENCE_INVALID_RRULE",
        `RRULE operator '${key}' is outside the supported subset`,
      );
    }
    parts.set(key, segment.slice(eq + 1));
  }

  const freqRaw = parts.get("FREQ");
  if (!freqRaw) throw new SchedulingStateError("RECURRENCE_INVALID_RRULE", "RRULE is missing FREQ");
  if (!SUPPORTED_RRULE_FREQ.includes(freqRaw as SupportedRruleFreq)) {
    throw new SchedulingStateError(
      "RECURRENCE_FREQUENCY_NOT_SUPPORTED",
      `FREQ='${freqRaw}' is not supported (only ${SUPPORTED_RRULE_FREQ.join(", ")})`,
    );
  }
  const freq = freqRaw as SupportedRruleFreq;

  if (parts.has("WKST") && parts.get("WKST") !== "MO") {
    throw new SchedulingStateError("RECURRENCE_INVALID_RRULE", "only WKST=MO is supported");
  }

  let interval = 1;
  if (parts.has("INTERVAL")) {
    interval = Number(parts.get("INTERVAL"));
    if (!Number.isInteger(interval) || interval < 1) {
      throw new SchedulingStateError(
        "RECURRENCE_INVALID_RRULE",
        "INTERVAL must be a positive integer",
      );
    }
  }

  const hasCount = parts.has("COUNT");
  const hasUntil = parts.has("UNTIL");
  if (hasCount && hasUntil) {
    throw new SchedulingStateError(
      "RECURRENCE_TERMINATOR_CONFLICT",
      "RRULE may carry COUNT or UNTIL, not both",
    );
  }
  let count: number | null = null;
  if (hasCount) {
    count = Number(parts.get("COUNT"));
    if (!Number.isInteger(count) || count < 1) {
      throw new SchedulingStateError(
        "RECURRENCE_INVALID_RRULE",
        "COUNT must be a positive integer",
      );
    }
  }
  const until = hasUntil ? parseUntil(parts.get("UNTIL") as string) : null;

  let byDay: readonly RruleByDay[] = [];
  if (freq === "WEEKLY") {
    const raw = parts.get("BYDAY");
    if (!raw)
      throw new SchedulingStateError("RECURRENCE_BYDAY_INVALID", "a WEEKLY rule requires BYDAY");
    const days = raw.split(",").map((d) => d.toUpperCase());
    for (const d of days) {
      if (!BYDAY_SET.has(d)) {
        throw new SchedulingStateError(
          "RECURRENCE_BYDAY_INVALID",
          `'${d}' is not a valid BYDAY weekday`,
        );
      }
    }
    // Preserve canonical week order; dedupe.
    byDay = RRULE_BYDAY.filter((d) => days.includes(d));
  } else if (parts.has("BYDAY")) {
    throw new SchedulingStateError(
      "RECURRENCE_INVALID_RRULE",
      "BYDAY is only supported on a WEEKLY rule",
    );
  }

  return { freq, interval, byDay, count, until };
}

/** The org-local calendar date (Monday-anchored) the WEEKLY interval counts weeks from. */
function mondayOnOrBefore(date: IsoDate): IsoDate {
  const daysSinceMonday = (dayOfWeekIndex(date) + 6) % 7; // Mon→0 … Sun→6
  return addCalendarDays(date, -daysSinceMonday);
}

/** Whether `rule` fires on org-local calendar day `d` given its `startDate` anchor. */
function firesOn(rule: ParsedRrule, d: IsoDate, startDate: IsoDate, weekAnchor: IsoDate): boolean {
  if (calendarDaysBetween(startDate, d) < 0) return false;
  if (rule.freq === "DAILY") {
    return calendarDaysBetween(startDate, d) % rule.interval === 0;
  }
  // WEEKLY
  if (!rule.byDay.includes(weekdayCode(d))) return false;
  const weekIndex = Math.floor(calendarDaysBetween(weekAnchor, d) / 7);
  return weekIndex % rule.interval === 0;
}

/** One materialized occurrence — an org-local service date + its start/end instants (DST-exact). */
export interface MaterializedOccurrence {
  readonly serviceDate: IsoDate;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
}

/** The inputs the materializer needs from a `recurring_visit` row + its parsed rule. */
export interface MaterializeInput {
  readonly rule: ParsedRrule;
  /** `recurring_visit.start_date` (the rule's DTSTART anchor). */
  readonly startDate: IsoDate;
  /** `recurring_visit.end_date` (an additional UNTIL bound; combined with `rule.until` — earliest wins). */
  readonly endDate: IsoDate | null;
  /** `recurring_visit.time_of_day_start` / `_end` (`HH:MM`, org-local). */
  readonly timeOfDayStart: string;
  readonly timeOfDayEnd: string;
  /** `recurring_visit.time_zone` (IANA). */
  readonly timeZone: string;
}

/** Earliest of two nullable dates (null = unbounded). */
function earliestDate(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return calendarDaysBetween(a, b) < 0 ? b : a;
}

/** Later of two `yyyy-mm-dd` dates. */
function laterDate(a: IsoDate, b: IsoDate): IsoDate {
  return calendarDaysBetween(a, b) > 0 ? b : a;
}

/**
 * Materialize the §7.7 rolling-horizon occurrence set for one recurring policy: the org-local service dates
 * (and their DST-exact start/end instants) the rule fires on within `[windowStart, windowStart +
 * horizonDays]`, honoring the `COUNT` / `UNTIL` / `end_date` terminators. Deterministic and idempotent — the
 * same inputs always produce the identical set, so the cron upserts on `(recurring_visit_id, service_date)`.
 *
 * When `COUNT` is set the enumeration starts at `startDate` so the Nth-occurrence cap is counted from the
 * rule's beginning (occurrences before the window still consume the count); otherwise it fast-forwards to
 * `max(startDate, windowStart)` since earlier occurrences are irrelevant. Either way it is bounded by
 * `windowStart + horizonDays`.
 */
export function materializeRecurrence(
  input: MaterializeInput,
  windowStart: IsoDate,
  horizonDays: number = MATERIALIZE_HORIZON_DAYS,
): MaterializedOccurrence[] {
  const { rule, startDate, endDate, timeOfDayStart, timeOfDayEnd, timeZone } = input;
  const horizonEnd = addCalendarDays(windowStart, horizonDays);
  const effectiveUntil = earliestDate(rule.until, endDate);
  const weekAnchor = mondayOnOrBefore(startDate);

  const out: MaterializedOccurrence[] = [];
  const cursor = rule.count !== null ? startDate : laterDate(startDate, windowStart);

  let occurrenceIndex = 0;
  for (let d = cursor; calendarDaysBetween(d, horizonEnd) >= 0; d = addCalendarDays(d, 1)) {
    if (effectiveUntil !== null && calendarDaysBetween(effectiveUntil, d) > 0) break;
    if (!firesOn(rule, d, startDate, weekAnchor)) continue;
    occurrenceIndex += 1;
    if (rule.count !== null && occurrenceIndex > rule.count) break;
    if (calendarDaysBetween(windowStart, d) < 0) continue; // before the rolling window — counted, not emitted
    out.push({
      serviceDate: d,
      scheduledStartedAt: atOrgLocalTime(d, timeOfDayStart, timeZone),
      scheduledEndedAt: atOrgLocalTime(d, timeOfDayEnd, timeZone),
    });
  }
  return out;
}

/**
 * Plan the §2.2.3 recurring-policy discontinuation. Throws `RECURRENCE_POLICY_NOT_ACTIVE` if the policy is
 * already discontinued. The cascade itself — cancelling every future-dated `proposed`/`published` child
 * visit — is executed by the service in the same tx (it loads those children and runs the visit machine's
 * `cancel`/`dismiss` per child); this returns the policy-row effects (audit + version bump + the
 * `m17.recurring_visit.discontinued` event carrying the cancelled-child count).
 */
export function planRecurrenceDiscontinuation(
  currentStatus: "active" | "discontinued",
): ReadonlyArray<SchedulingSideEffect> {
  require_(
    currentStatus === "active",
    "RECURRENCE_POLICY_NOT_ACTIVE",
    "the recurring policy is already discontinued",
  );
  return [
    { kind: "set_timestamp", field: "discontinued_at" },
    { kind: "bump_version" },
    { kind: "audit" },
    { kind: "outbox", event: "m17.recurring_visit.discontinued" },
  ];
}
