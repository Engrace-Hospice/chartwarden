// apps/backend/src/modules/16-bereavement/mailings/occurrence.ts — ADR-0109 D10: when is each configured mailing due?
//
// PURE date math, all in UTC calendar dates (`YYYY-MM-DD`): the sweep runs every five minutes and must derive the same occurrence key for the
// same mailing every time, so the key never depends on a clock-of-day or a time zone.
//
//   newsletter_quarterly  four dates a year (default 01-15, 04-15, 07-15, 10-15; a tenant overrides `schedule.monthDays`); key `<mailingKey>:<YYYY>-Q<n>`
//                         where n is the date's position in the sorted list.
//   holiday_december      one date (default 12-15, overridable `schedule.monthDay`);                           key `<mailingKey>:<YYYY>`
//   mothers_day           the 2nd Sunday of May;                                                              key `<mailingKey>:<YYYY>`
//   fathers_day           the 3rd Sunday of June;                                                             key `<mailingKey>:<YYYY>`
//   decedent_birthday     DEFERRED (M16 holds no date of birth): kept as a config value, produces NO occurrence.
//
// `scheduledFor` is the date the mailing is FOR (the holiday, the issue date). The run is drafted `leadDays` before it, so staff have time to
// generate, print and mail; an occurrence whose date has already passed is never drafted late.
import type { BereavementMailingKey } from "@chartwarden/types";

const MS_PER_DAY = 86_400_000;

export const DEFAULT_NEWSLETTER_MONTH_DAYS: readonly string[] = ["01-15", "04-15", "07-15", "10-15"];
export const DEFAULT_DECEMBER_MONTH_DAY = "12-15";
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The tenant's schedule overrides (`bereavement_mailing_config.schedule_jsonb`); anything malformed falls back to the default. */
export interface MailingSchedule {
  readonly monthDays?: readonly string[];
  readonly monthDay?: string;
}

export interface MailingOccurrenceConfig {
  readonly mailingKey: BereavementMailingKey;
  readonly enabled: boolean;
  readonly leadDays: number;
  readonly schedule?: MailingSchedule | null;
}

export interface MailingOccurrence {
  readonly mailingKey: BereavementMailingKey;
  readonly occurrenceKey: string;
  /** `YYYY-MM-DD`: the date the mailing is for. */
  readonly scheduledFor: string;
  /** `YYYY-MM-DD`: `scheduledFor` minus the lead days: the first day the run may be drafted. */
  readonly draftFrom: string;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcMs = (year: number, month: number, day: number): number => Date.UTC(year, month - 1, day);

/** The `nth` (1-based) Sunday of a month: 2 = Mother's Day (May), 3 = Father's Day (June). */
export function nthSundayOfMonth(year: number, month: number, nth: number): string {
  const first = utcMs(year, month, 1);
  const firstDow = new Date(first).getUTCDay(); // 0 = Sunday
  const offset = (7 - firstDow) % 7;
  return isoDate(first + (offset + (nth - 1) * 7) * MS_PER_DAY);
}

const validMonthDay = (value: unknown): value is string =>
  typeof value === "string" && MONTH_DAY_RE.test(value);

/** A month-day that does not exist in this year (02-29 in a common year) is dropped, never rolled into March. */
function dateOf(year: number, monthDay: string): string | null {
  const [m, d] = monthDay.split("-").map(Number) as [number, number];
  const ms = utcMs(year, m, d);
  return new Date(ms).getUTCMonth() + 1 === m ? isoDate(ms) : null;
}

function newsletterMonthDays(schedule: MailingSchedule | null | undefined): readonly string[] {
  const configured = schedule?.monthDays;
  const valid = Array.isArray(configured) ? [...new Set(configured.filter(validMonthDay))] : [];
  return (valid.length > 0 ? valid : [...DEFAULT_NEWSLETTER_MONTH_DAYS]).sort();
}

/** The dates a config occurs on in one calendar year, with their keys (unsorted by lead; callers filter by the draft window). */
function occurrencesInYear(
  config: MailingOccurrenceConfig,
  year: number,
): readonly { occurrenceKey: string; scheduledFor: string }[] {
  const key = config.mailingKey;
  switch (key) {
    case "newsletter_quarterly":
      return newsletterMonthDays(config.schedule).flatMap((monthDay, index) => {
        const date = dateOf(year, monthDay);
        return date === null ? [] : [{ occurrenceKey: `${key}:${year}-Q${index + 1}`, scheduledFor: date }];
      });
    case "holiday_december": {
      const configured = config.schedule?.monthDay;
      const date = dateOf(year, validMonthDay(configured) ? configured : DEFAULT_DECEMBER_MONTH_DAY);
      return date === null ? [] : [{ occurrenceKey: `${key}:${year}`, scheduledFor: date }];
    }
    case "mothers_day":
      return [{ occurrenceKey: `${key}:${year}`, scheduledFor: nthSundayOfMonth(year, 5, 2) }];
    case "fathers_day":
      return [{ occurrenceKey: `${key}:${year}`, scheduledFor: nthSundayOfMonth(year, 6, 3) }];
    case "decedent_birthday":
      return []; // deferred: no date of birth in M16
  }
}

/**
 * The occurrences of the ENABLED configs whose draft window is open on `today`: `draftFrom <= today <= scheduledFor`.
 * Looks across the year boundary (a January newsletter drafts in late December). Sorted by `scheduledFor`, then key.
 */
export function nextOccurrences(
  configs: readonly MailingOccurrenceConfig[],
  today: string,
): readonly MailingOccurrence[] {
  const year = Number(today.slice(0, 4));
  const found: MailingOccurrence[] = [];
  for (const config of configs) {
    if (!config.enabled) continue;
    for (const y of [year, year + 1]) {
      for (const occ of occurrencesInYear(config, y)) {
        const draftFrom = isoDate(Date.parse(`${occ.scheduledFor}T00:00:00.000Z`) - config.leadDays * MS_PER_DAY);
        if (draftFrom <= today && today <= occ.scheduledFor) {
          found.push({ mailingKey: config.mailingKey, ...occ, draftFrom });
        }
      }
    }
  }
  return found.sort(
    (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.occurrenceKey.localeCompare(b.occurrenceKey),
  );
}

/** A mailing key's run kind (`bereavement_mailing_run.run_kind`). */
export const runKindOf = (key: BereavementMailingKey): "newsletter" | "holiday" =>
  key === "newsletter_quarterly" ? "newsletter" : "holiday";

/** A mailing key's contact-log activity kind (`bereavement_contact_log.activity_kind`). */
export const activityKindOf = (key: BereavementMailingKey): "newsletter_mailing" | "holiday_mailing" =>
  key === "newsletter_quarterly" ? "newsletter_mailing" : "holiday_mailing";
