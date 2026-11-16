// apps/web/src/modules/10-hope — small formatting helpers shared by the HOPE screens.
import { formatDateOnly, isoToLocalInput } from "@chartwarden/ui";

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
 * A server INSTANT as the viewer's own `YYYY-MM-DD HH:mm` (the zone is the viewer's, never the UTC wall time with no zone on it:
 * 8:30 PM CDT on Sep 11 is stored as 2026-09-12T01:30Z and must not read as Sep 12). The raw value when it cannot be read.
 * Also what a screen's search box must match for a column it shows this way.
 */
export function formatInstantDateTime(value: string | null | undefined): string {
  return isoToLocalInput(value).replace("T", " ") || (value ?? "");
}

/**
 * A timepoint's target date. It is stored as a timestamp, but is either a date (midnight UTC) or the instant the clinician chose
 * in a datetime-local field: the strict date shapes keep their calendar day (as `formatDateOnly` defines them), anything else is
 * an instant shown in the viewer's zone.
 *
 * KNOWN AMBIGUITY (web-k25/k26, a product call): the two cannot be told apart when the value is exactly midnight UTC. A visit a
 * clinician enters as 8:00 PM EDT on Sep 8 (zero seconds) is sent as 2026-09-09T00:00:00.000Z, which is also how a date column
 * serializes Sep 9, so it is shown as Sep 9 here, not the viewer's Sep 8. The window is one local minute a day (per zone) and
 * the old `slice(0, 10)` read the same day, so this is not a regression; it ends only when every writer that sends an instant
 * avoids exact midnight UTC, or the server says which kind of value it holds. `g2-format-target-date.test.ts` pins this.
 */
export function formatTargetDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const dateOnly = formatDateOnly(value);
  return dateOnly === value ? formatInstant(value) : dateOnly;
}
