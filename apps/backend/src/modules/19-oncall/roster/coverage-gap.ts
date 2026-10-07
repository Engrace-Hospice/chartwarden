// apps/backend/src/modules/19-oncall/roster/coverage-gap.ts — the §4.8 `coverage-gap-watchdog` predicate (GAP-057).
//
// PURE: windows in, the first uncovered `clinical_rn` interval out. The cron (`../jobs/coverage-gap-watchdog.ts`)
// does the reads and the publish; the decision lives here so the §9 tests and the worker share one definition.
//
// WHAT COUNTS AS COVERAGE. A `scheduled` or `active` clinical_rn shift covers its window (a scheduled shift
// past its start is one shift-open tick from active — the same reading `shiftCoversInstant` takes). A
// `completed` shift covers nothing ahead of `now` (an early close is a window that stopped — see
// `./shift-machine`), and a `cancelled` one never covered anything, so the caller filters both out before
// calling. ONE gap per call — the earliest — because the page is "this ProviderEntity has a hole", and the
// 30-minute cadence re-reports the next one once the first is filled.
import type { IsoInstant } from "@wardenx/types";

/** A clinical_rn coverage window, already filtered to the statuses that count. */
export interface RnShiftWindow {
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
}

/** The earliest uncovered stretch of the lookahead. */
export interface RnCoverageGap {
  readonly gapStartsAt: IsoInstant;
  readonly gapEndsAt: IsoInstant;
}

/**
 * The first uncovered interval inside `[from, to)`, or `null` when the window is fully covered. A window with
 * no shifts at all is the whole lookahead. Zero-length slivers (touching shifts) are not gaps.
 */
export function firstRnCoverageGap(
  windows: readonly RnShiftWindow[],
  from: IsoInstant,
  to: IsoInstant,
): RnCoverageGap | null {
  const sorted = [...windows].sort((a, b) => a.shiftStartsAt.localeCompare(b.shiftStartsAt));
  let cursor = from;
  for (const w of sorted) {
    if (w.shiftEndsAt <= cursor) continue;
    if (w.shiftStartsAt > cursor) {
      return { gapStartsAt: cursor, gapEndsAt: w.shiftStartsAt < to ? w.shiftStartsAt : to };
    }
    cursor = w.shiftEndsAt;
    if (cursor >= to) return null;
  }
  return cursor < to ? { gapStartsAt: cursor, gapEndsAt: to } : null;
}
