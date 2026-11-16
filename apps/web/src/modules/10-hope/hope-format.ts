// apps/web/src/modules/10-hope — small formatting helpers shared by the HOPE screens.
import { formatDateOnly } from "@chartwarden/ui";

/**
 * A calendar DATE ("2026-09-01", or a date column's midnight-UTC serialization) as its short date; "Not recorded" for none.
 * Never for an INSTANT (a window bound, a due, signed or completed time): its UTC day is the next day for a US evening. Use
 * `formatInstant` for those.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = value.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return value;
  // A calendar date built at UTC midnight must also be FORMATTED in UTC — formatting it in the
  // viewer's zone showed the day before everywhere west of Greenwich (DOB, target date).
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * A server INSTANT (a window bound, a due, completed or signed time) as the viewer's short date, in the viewer's zone (as the
 * capture workspace words the same bounds). A window ending at an org's local midnight is stored as a UTC instant, so its UTC day
 * can be the day after the one the org (and the viewer) sees. "Not recorded" for none; an unparseable value is returned as is.
 */
export function formatInstant(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * A timepoint's target date. It is stored as a timestamp, but is either a date (midnight UTC) or the instant the clinician chose
 * in a datetime-local field: the strict date shapes keep their calendar day (as `formatDateOnly` defines them), anything else is
 * an instant shown in the viewer's zone.
 */
export function formatTargetDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const dateOnly = formatDateOnly(value);
  return dateOnly === value ? formatInstant(value) : dateOnly;
}
