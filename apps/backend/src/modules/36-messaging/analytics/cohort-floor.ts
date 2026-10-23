// apps/backend/src/modules/36-messaging/analytics/cohort-floor.ts - WP 6.2 (ADR-0092): small-cell suppression, pure.
//
// Rules (provisional minimums, ADR-0092 D6): `minCohort` DISTINCT people AND `minRequests` requests stand behind every shown figure.
//   1. a group is shown only when at least `minCohort` distinct people AND `minRequests` requests stand behind it, and no single person
//      owns more than `maxShare` of its requests (a one-person cell in all but name);
//   2. complementary suppression: "organisation-wide figures minus the shown groups" is exactly the combined hidden residual, so that
//      residual must itself clear BOTH floors, people counted over the UNION of the hidden groups' members (one person in several hidden
//      groups counts once; per-group counts must never be added) and requests summed. While the residual is under either floor the
//      smallest remaining visible group (fewest requests, then name) is withheld too;
//   3. if no visible group is left and the residual is still under a floor, the whole breakdown is withheld (`withheld`).
// Members are opaque ids used only inside this module and never returned. Only the NUMBER of hidden groups is returned.
import type { ResponseAnalyticsCell } from "@chartwarden/types";

export interface RawGroupRow extends ResponseAnalyticsCell {
  /** One assignee id PER REQUEST (repeats kept, so a person's share is computable). Never leaves this module. */
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
const requestsOf = (rows: readonly RawGroupRow[]): number =>
  rows.reduce((sum, r) => sum + r.requests, 0);

/** The largest number of requests any one person owns in the group. */
function topPersonRequests(row: RawGroupRow): number {
  const counts = new Map<string, number>();
  for (const m of row.members) counts.set(m, (counts.get(m) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

export interface FloorLimits {
  readonly minCohort: number;
  readonly minRequests: number;
  /** A group where one person owns more than this share of the requests is withheld. */
  readonly maxPersonShare: number;
}

const clearsFloor = (row: RawGroupRow, l: FloorLimits): boolean =>
  new Set(row.members).size >= l.minCohort &&
  row.requests >= l.minRequests &&
  topPersonRequests(row) <= l.maxPersonShare * row.requests;

export function applyCohortFloor(rows: readonly RawGroupRow[], limits: FloorLimits): FlooredGroups {
  let visible = rows.filter((r) => clearsFloor(r, limits));
  let hidden = rows.filter((r) => !clearsFloor(r, limits));
  while (
    hidden.length > 0 &&
    (distinct(hidden) < limits.minCohort || requestsOf(hidden) < limits.minRequests)
  ) {
    const smallest = [...visible].sort(
      (a, b) => a.requests - b.requests || a.group.localeCompare(b.group),
    )[0];
    if (!smallest) return { cells: [], suppressedGroups: rows.length, withheld: true };
    visible = visible.filter((r) => r !== smallest);
    hidden = [...hidden, smallest];
  }
  return { cells: visible.map(toCell), suppressedGroups: hidden.length, withheld: false };
}
