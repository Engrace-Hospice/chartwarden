// @chartwarden/ui core — date-ONLY helpers (PARAM-004). `new Date("1950-03-15")` parses a bare
// `YYYY-MM-DD` string as a UTC INSTANT (midnight UTC), and every local getter (`getFullYear()`,
// `getMonth()`, `getDate()`) then reads it back in the BROWSER's local timezone. In any
// negative-UTC-offset timezone (every US timezone), UTC midnight on a date is still the PREVIOUS
// day locally, so the parsed date silently reads one day early — an off-by-one in a displayed DOB,
// and a real (if rare, near-birthday) off-by-one in a computed age. Was copy-pasted, buggy, into 11
// separate `apps/web` screens (`ageYears`); this is the one shared, fixed implementation.

/**
 * Parse a date-ONLY string (`YYYY-MM-DD`, optionally with a trailing time/offset that is ignored)
 * as LOCAL calendar-date components, never as a UTC instant. Returns `null` for anything that
 * isn't a well-formed `YYYY-MM-DD` prefix.
 */
export function parseLocalDateOnly(dateOnly: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Reject an out-of-range component the constructor would otherwise silently roll over (e.g.
  // month 13 rolling into next January) — a rolled-over date is a data problem, not a valid one.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/**
 * Whole years between a date-only `dob` (`YYYY-MM-DD`) and today, using LOCAL calendar dates on
 * both sides (never a UTC-instant comparison). Returns `null` for an unparseable or implausible
 * (negative or ≥150) age — this guards a display surface, not a clinical calculation.
 */
export function ageYears(dob: string): number | null {
  const d = parseLocalDateOnly(dob);
  if (!d) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const monthDelta = now.getMonth() - d.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

const DATE_ONLY_STRICT = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/;

/**
 * Display a date-ONLY value as the viewer's locale date WITHOUT the UTC-midnight shift: the calendar
 * day stored is the calendar day shown, in every time zone. Strict: accepts exactly `YYYY-MM-DD` or
 * the midnight-UTC serialization of a date column (`YYYY-MM-DDT00:00:00(.000)Z`). Anything else —
 * including a real instant, whose calendar day depends on the viewer's zone — is returned unchanged
 * so it stays visible instead of silently showing the UTC day. Format instants in the viewer's zone.
 */
export function formatDateOnly(
  dateOnly: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
): string {
  if (!DATE_ONLY_STRICT.test(dateOnly)) return dateOnly;
  const d = parseLocalDateOnly(dateOnly);
  return d ? new Intl.DateTimeFormat(undefined, options).format(d) : dateOnly;
}
