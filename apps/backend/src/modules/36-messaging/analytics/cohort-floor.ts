// apps/backend/src/modules/36-messaging/analytics/cohort-floor.ts - WP 6.2 (ADR-0110): small-cell suppression, pure.
//
// A group is shown only when at least `minCohort` DISTINCT people stand behind it. Complementary suppression: if exactly one group would
// be hidden, the smallest visible group is hidden too, so "org total minus shown groups" can never isolate one small group.
// The number of hidden groups is returned (a count of groups, never their names or sizes).
import type { ResponseAnalyticsCell } from "@chartwarden/types";

export interface RawGroupRow extends ResponseAnalyticsCell {
  /** Distinct people (assignees) behind the group. Never leaves this module. */
  readonly people: number;
}

export interface FlooredGroups {
  readonly cells: readonly ResponseAnalyticsCell[];
  readonly suppressedGroups: number;
}

function toCell({ people: _people, ...cell }: RawGroupRow): ResponseAnalyticsCell {
  return cell;
}

export function applyCohortFloor(rows: readonly RawGroupRow[], minCohort: number): FlooredGroups {
  const visible = rows.filter((r) => r.people >= minCohort);
  const hiddenCount = rows.length - visible.length;
  if (hiddenCount !== 1 || visible.length === 0) {
    return { cells: visible.map(toCell), suppressedGroups: hiddenCount };
  }
  // Exactly one hidden: hide the visible group with the fewest requests as well (ties: first by name, deterministic).
  const smallest = [...visible].sort(
    (a, b) => a.requests - b.requests || a.group.localeCompare(b.group),
  )[0];
  const kept = visible.filter((r) => r !== smallest);
  return { cells: kept.map(toCell), suppressedGroups: 2 };
}
