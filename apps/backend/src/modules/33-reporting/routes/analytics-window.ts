// apps/backend/src/modules/33-reporting/routes/analytics-window.ts - M33 serving M36 WP 6.2 (ADR-0110): the window rule.
//
// `from` and `to` are caller-chosen instants, and two windows that differ by a small slice would isolate the few requests in that slice
// (difference the two answers). So the server, not the caller, decides the window: it is whole UTC days.
//   from' = start of the UTC day containing `from`
//   to'   = start of the UTC day AFTER the one containing `to`   (the day of `to` is included whole; a midnight `to` includes its own day)
// Any two requests whose endpoints fall on the same UTC days get byte-identical windows, so sub-day input cannot isolate anything. The 92-day
// cap is measured on the snapped window. Windows that differ by one or more WHOLE days still difference (documented residue, ADR-0110 D6).
import { ANALYTICS_MAX_RANGE_DAYS, ValidationError } from "@chartwarden/types";

export const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;

const startOfUtcDay = (instant: Date): Date =>
  new Date(Math.floor(instant.getTime() / DAY_MS) * DAY_MS);

function invalid(field: string, message: string): ValidationError {
  return new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

export function resolveAnalyticsWindow(
  q: { readonly from?: string; readonly to?: string },
  now: Date,
): { from: Date; to: Date } {
  const rawTo = q.to ? new Date(q.to) : now;
  const rawFrom = q.from
    ? new Date(q.from)
    : new Date(rawTo.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (rawFrom > rawTo) throw invalid("from", "from must not be after to");
  const from = startOfUtcDay(rawFrom);
  const to = new Date(startOfUtcDay(rawTo).getTime() + DAY_MS);
  if (to.getTime() - from.getTime() > ANALYTICS_MAX_RANGE_DAYS * DAY_MS) {
    throw invalid("to", `the range is at most ${ANALYTICS_MAX_RANGE_DAYS} days (whole UTC days)`);
  }
  return { from, to };
}
