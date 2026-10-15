// apps/backend/src/modules/36-messaging/ack-requests/ack-escalation-note.ts - WP 4.4: why an overdue open request has not moved on.
// A READ-time fact for the card, derived from the append-only history with ONE batched query: the newest `route_unavailable` /
// `ladder_exhausted` row written for the CURRENT window (a reassign or an escalation starts a new window, so an older row is history).
import type { AckEscalationNote } from "@wardenx/types";
import type { AckRow, AckTx } from "./ack-types";

/** One note per overdue, still-waiting request that has one; every other request gets none. Reads only. */
export async function escalationNotes(
  tx: AckTx,
  rows: readonly AckRow[],
  now: Date,
): Promise<ReadonlyMap<string, AckEscalationNote>> {
  const overdue = rows.filter(
    (r) =>
      (r.status === "pending" || r.status === "escalated") &&
      r.deadlineAt.getTime() <= now.getTime(),
  );
  const summary = await tx.unroutedSummary(overdue);
  return new Map([...summary].map(([id, u]) => [id, u.lastType]));
}
