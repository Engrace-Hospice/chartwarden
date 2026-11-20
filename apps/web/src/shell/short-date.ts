// apps/web/src/shell — one short calendar-date label for the visit findings and the wounds screens: "Nov 19, 2026".
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ShortDateOptions {
  /** Leave the year off a date in the same year as this one ("Nov 4"), as a line that sits beside today's visit reads best. */
  readonly yearlessIn?: Date;
}

/**
 * The date of an ISO instant or a `YYYY-MM-DD` date. A date-only value is read as that calendar day (the time zone does not shift it);
 * nothing, "—"; a value that is not a date (or a day that does not exist, like month 13) comes back as it was given.
 */
export function shortDate(
  value: string | null | undefined,
  { yearlessIn }: ShortDateOptions = {},
): string {
  if (!value) return "—";
  const dateOnly = DATE_ONLY.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // A calendar day that rolled over (month 13, February 30) was never a date.
  if (dateOnly && date.getMonth() !== Number(dateOnly[2]) - 1) return value;
  const sameYear = yearlessIn !== undefined && date.getFullYear() === yearlessIn.getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
