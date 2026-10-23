// apps/backend/src/modules/33-reporting/routes/analytics-window.ts - M33 serving M36 WP 6.2 (ADR-0092): the window rule.
//
// `from` and `to` are caller-chosen instants. Two overlapping windows that differ by a small slice would isolate the few requests in that
// slice (difference the two answers), and a window that includes the current, still-growing day would let a poller difference successive
// answers through the day. So the server, not the caller, decides the window: COMPLETED UTC DAYS ONLY.
//   from' = start of the UTC day containing `from`
//   to'   = min( start of the UTC day AFTER the one containing `to` , start of the CURRENT UTC day )
// Any two requests whose endpoints fall on the same UTC days get byte-identical windows, and a request made at 01:00 and one at 23:00 on the
// same UTC day see the same data (today is never included). The 92-day cap is measured on the final window. A window with no completed day
// in it (only today, or the future) is `null`: the route answers insufficient_data. Windows that differ by one or more WHOLE days still
// difference (documented residue, ADR-0092 D6). `now` is injected so the rule is testable.
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
): { from: Date; to: Date } | null {
  const rawTo = q.to ? new Date(q.to) : now;
  const rawFrom = q.from
    ? new Date(q.from)
    : new Date(rawTo.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (rawFrom > rawTo) throw invalid("from", "from must not be after to");
  const from = startOfUtcDay(rawFrom);
  const today = startOfUtcDay(now);
  const dayAfterTo = new Date(startOfUtcDay(rawTo).getTime() + DAY_MS);
  const to = dayAfterTo < today ? dayAfterTo : today;
  if (!(from < to)) return null;
  if (to.getTime() - from.getTime() > ANALYTICS_MAX_RANGE_DAYS * DAY_MS) {
    throw invalid("to", `the range is at most ${ANALYTICS_MAX_RANGE_DAYS} days (whole UTC days)`);
  }
  return { from, to };
}
