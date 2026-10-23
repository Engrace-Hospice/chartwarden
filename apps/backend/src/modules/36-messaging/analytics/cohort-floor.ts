// apps/backend/src/modules/36-messaging/analytics/cohort-floor.ts - WP 6.2 (ADR-0110): small-cell suppression, pure.
//
// Rules (provisional minimum `minCohort`, counted in DISTINCT people):
//   1. a group is shown only when at least `minCohort` distinct people stand behind it;
//   2. complementary suppression: "organisation-wide figures minus the shown groups" is exactly the combined hidden residual, so that
//      residual must itself involve at least `minCohort` distinct people, counted over the UNION of the hidden groups' members (one
//      person in several hidden groups counts once; per-group counts must never be added). While the residual is under the floor the
//      smallest remaining visible group (fewest requests, then name) is withheld too;
//   3. if no visible group is left and the residual is still under the floor, the whole breakdown is withheld (`withheld`).
// Members are opaque ids used only inside this module and never returned. Only the NUMBER of hidden groups is returned.
import type { ResponseAnalyticsCell } from "@chartwarden/types";

export interface RawGroupRow extends ResponseAnalyticsCell {
  /** The distinct people (assignee ids) behind the group. Never leaves this module. */
  readonly members: readonly string[];
}

export interface FlooredGroups {
  readonly cells: readonly ResponseAnalyticsCell[];
  readonly suppressedGroups: number;
  /** True when the breakdown cannot be shown at all without exposing a small residual. */
  readonly withheld: boolean;
}

function toCell({ members: _members, ...cell }: RawGroupRow): ResponseAnalyticsCell {
  return cell;
}

const distinct = (rows: readonly RawGroupRow[]): number =>
  new Set(rows.flatMap((r) => r.members)).size;

export function applyCohortFloor(rows: readonly RawGroupRow[], minCohort: number): FlooredGroups {
  let visible = rows.filter((r) => new Set(r.members).size >= minCohort);
  let hidden = rows.filter((r) => new Set(r.members).size < minCohort);
  while (hidden.length > 0 && distinct(hidden) < minCohort) {
    const smallest = [...visible].sort(
      (a, b) => a.requests - b.requests || a.group.localeCompare(b.group),
    )[0];
    if (!smallest) return { cells: [], suppressedGroups: rows.length, withheld: true };
    visible = visible.filter((r) => r !== smallest);
    hidden = [...hidden, smallest];
  }
  return { cells: visible.map(toCell), suppressedGroups: hidden.length, withheld: false };
}
