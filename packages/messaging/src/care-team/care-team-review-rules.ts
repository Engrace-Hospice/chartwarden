// M36 WP 3.9 - the pure care-team-removal rules (ADR-0066). No I/O: the consumer-side router calls these.

/** Review items queued per care-team-change event; above it the rest are left out and counted (ids never logged). */
export const CARE_TEAM_REVIEW_MAX_ITEMS = 500;

/** Route only when the clinician is really off the roster (a second open role keeps them on the team). */
export function shouldRoute(roster: readonly string[], clinicianUserId: string): boolean {
  return !roster.includes(clinicianUserId);
}

/** Sorted, de-duplicated and capped task ids: the same event always queues the same set. */
export function reviewItemsFor(taskIds: readonly string[]): {
  taskIds: string[];
  truncated: number;
} {
  const sorted = [...new Set(taskIds)].sort();
  // ponytail: first 500 only; page it if a real caseload exceeds the cap.
  return {
    taskIds: sorted.slice(0, CARE_TEAM_REVIEW_MAX_ITEMS),
    truncated: Math.max(0, sorted.length - CARE_TEAM_REVIEW_MAX_ITEMS),
  };
}

/** The assignment_ended payload has no assignment id, so the outbox event's own id is the trigger reference. */
export function careTeamTriggerRef(outboxEventId: string): string {
  return outboxEventId;
}
