// M36 WP 3.9 - the pure care-team-removal rules (ADR-0066). No I/O: the consumer-side router calls these.

import { REVIEW_QUEUE_BATCH } from "../review/review-rules";

/** Route only when the clinician is really off the roster (a second open role keeps them on the team). */
export function shouldRoute(roster: readonly string[], clinicianUserId: string): boolean {
  return !roster.includes(clinicianUserId);
}

/** Sorted, de-duplicated task ids in batches: the same event always queues the same set, none are dropped. */
export function reviewItemBatches(
  taskIds: readonly string[],
  batchSize: number = REVIEW_QUEUE_BATCH,
): string[][] {
  const sorted = [...new Set(taskIds)].sort();
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += batchSize) batches.push(sorted.slice(i, i + batchSize));
  return batches;
}

/** The assignment_ended payload has no assignment id, so the outbox event's own id is the trigger reference. */
export function careTeamTriggerRef(outboxEventId: string): string {
  return outboxEventId;
}
