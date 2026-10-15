// apps/backend/src/modules/36-messaging/ack-requests/ack-escalation-note.ts - WP 4.4: why an overdue open request has not moved on.
// A READ-time fact for the card, derived from the append-only history: the newest `route_unavailable` / `ladder_exhausted` row
// written for the CURRENT window (a reassign or an escalation starts a new window, so an older row is history, not today's state).
import type { AckEscalationNote } from "@wardenx/types";
import type { AckRow, AckTx } from "./ack-types";

const NOTES = [
  "route_unavailable",
  "ladder_exhausted",
] as const satisfies readonly AckEscalationNote[];

/** One note per overdue, still-waiting request that has one; every other request gets none. Reads only. */
export async function escalationNotes(
  tx: AckTx,
  rows: readonly AckRow[],
  now: Date,
): Promise<ReadonlyMap<string, AckEscalationNote>> {
  const notes = new Map<string, AckEscalationNote>();
  for (const row of rows) {
    if (row.status !== "pending" && row.status !== "escalated") continue;
    if (row.deadlineAt.getTime() > now.getTime()) continue;
    let newest: { note: AckEscalationNote; at: number } | null = null;
    for (const note of NOTES) {
      const at = await tx.lastEventAt(row.id, note);
      if (
        at &&
        at.getTime() >= row.windowStartedAt.getTime() &&
        (!newest || at.getTime() > newest.at)
      ) {
        newest = { note, at: at.getTime() };
      }
    }
    if (newest) notes.set(row.id, newest.note);
  }
  return notes;
}
