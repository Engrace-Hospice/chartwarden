// apps/web/src/modules/08-encounters/workspace — the scheduled window of a visit as one short line ("Aug 31, 9:00 AM - 10:00 AM"). The
// schedule's own times, in the reader's time zone; never an actual (EVV) time, which this screen has no source for.
const DATE_AND_TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
const TIME_ONLY: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

const validDate = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** `null` when the start is not a date; an end that is not a date or not after the start is left off. */
export function visitWindowLabel(startIso: string, endIso: string): string | null {
  const start = validDate(startIso);
  if (!start) return null;
  const from = start.toLocaleString("en-US", DATE_AND_TIME);
  const end = validDate(endIso);
  if (!end || end.getTime() <= start.getTime()) return from;
  const to = end.toLocaleString("en-US", sameDay(start, end) ? TIME_ONLY : DATE_AND_TIME);
  return `${from} - ${to}`;
}
