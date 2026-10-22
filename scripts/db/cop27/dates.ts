/**
 * COP27 API seed — calendar helpers. Every date the seed writes is relative to "today" in the service-location timezone,
 * clamped to the backend's date zone (see SERVER_TZ), so deadlines (5-day initial addendum, 3-day update, F2F windows) are meaningful
 * whenever the seed runs.
 */

/** The FY2027 rule's applicability date: elections and live discharges on/after it owe the new documents. */
export const FY2027_EFFECTIVE = "2026-10-01";

const DAY_MS = 86_400_000;

/** yyyy-mm-dd of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return parts; // en-CA formats as yyyy-mm-dd
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Noon UTC on `date` — a safe instant inside that calendar day in every US timezone. */
export function noonUtc(date: string): string {
  return `${date}T12:00:00.000Z`;
}

/** The later of `date`'s noon and one minute ago: an instant on `date` that is never in the future. */
export function pastInstantOn(date: string, now: Date): string {
  const noon = Date.parse(noonUtc(date));
  return new Date(Math.min(noon, now.getTime() - 60_000)).toISOString();
}

export interface SeedCalendar {
  readonly timeZone: string;
  readonly today: string;
  /** today + n days (negative = past). */
  readonly rel: (days: number) => string;
}

/** The backend validates dates against this zone (`DEFAULT_ORG_TZ`, recert-period-activation.ts), not the
 * location's own, so a seed "today" that is ahead of it is rejected as "in the future" (F2F encounter dates)
 * and leaves a just-opened care plan not yet current. */
const SERVER_TZ = "America/Los_Angeles";

export function seedCalendar(timeZone: string, now = new Date()): SeedCalendar {
  const today = minDate(localDate(now, timeZone), localDate(now, SERVER_TZ));
  return { timeZone, today, rel: (days: number) => addDays(today, days) };
}
