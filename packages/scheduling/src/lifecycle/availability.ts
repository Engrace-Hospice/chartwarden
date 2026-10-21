// @chartwarden/scheduling — §2.2.5 D7 clinician_availability validation (M17-T03). Pure, IO-free.
//
// `clinician_availability` is a weekly recurring pattern, not a lifecycle aggregate: one row per
// `(membership_id, day_of_week)` with a `start_time`/`end_time` window and optimistic `version`. It has no
// state machine, but it does carry the §2.3 write-time invariant the day/week views and the `not_on_pto` /
// availability-bounds gate predicates rely on: `start_time < end_time`. Overnight shifts (e.g. a 22:00 →
// 06:00 on-call window) are not a single wrap-around row — per §2.3 they split into two same-discipline
// rows, so a non-ordered window is a client error, not a wrap. The §2.3 DB CHECK repeats this as defense in
// depth (M17-T02).
import { SchedulingStateError } from "./errors";

/** Parse a `HH:MM` (24h) wall-clock string into whole minutes-since-midnight. */
function minutesOfDay(timeOfDay: string): number {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  return (hh ?? 0) * 60 + (mm ?? 0);
}

/**
 * Assert a §2.2.5 availability window is well-formed: `start_time < end_time` (both `HH:MM` org-local).
 * Throws {@link SchedulingStateError} `AVAILABILITY_WINDOW_INVALID` otherwise (overnight windows split into
 * two rows per §2.3, so an out-of-order window is never a legal wrap-around).
 */
export function assertAvailabilityWindowValid(startTime: string, endTime: string): void {
  if (minutesOfDay(startTime) >= minutesOfDay(endTime)) {
    throw new SchedulingStateError(
      "AVAILABILITY_WINDOW_INVALID",
      `availability start_time (${startTime}) must be before end_time (${endTime}); overnight shifts split into two rows`,
    );
  }
}
