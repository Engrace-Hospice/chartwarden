// apps/backend/src/modules/14-idg/jobs/carry-forward-count.ts — the DERIVED `idg_action_item.meeting_carry_forward_count`.
//
// The count is the number of DISTINCT, NON-CANCELLED meetings an action item has been carried into: the count of
// `idg_agenda_item` rows of `kind = 'carry_forward'` for that item, joined to `idg_meeting`, excluding meetings whose
// status is `cancelled` or `rescheduled` (a meeting that never took place / moved away must not count toward the D8
// "3 meetings" compliance threshold — the successor meeting that carries the item instead counts once).
//
// It is RE-DERIVED, never blindly incremented, at the two moments it can change:
//   1. by `idg.carry-forward` (carry-forward.ts) inside its per-org tx, right after a new agenda row is inserted;
//   2. by the meeting CANCEL / RESCHEDULE path (idg-route-service-db.ts), in the same tx as the status change, for
//      every item the meeting had carried — one indexed read + at most one UPDATE per affected item, so it is cheap
//      and the packet builder's stored-count reader (`packet-build.ts`) never sees a stale value.
// The unique index `idg_agenda_item_carry_forward_uq` (migration 0285) still makes the carry itself idempotent; this
// only fixes what is counted.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

const MTG = schema.idgMeeting;
const AGD = schema.idgAgendaItem;
const ACT = schema.idgActionItem;

/** Meeting statuses that do NOT count as "carried into a meeting" (the meeting did not happen / moved away). */
export const NON_COUNTING_MEETING_STATUSES = ["cancelled", "rescheduled"] as const;

export interface CarryForwardCountChange {
  readonly previous: number;
  readonly current: number;
}

/** Re-derive the count for `actionItemIds` and persist it where it differs. Returns the before/after of the ROWS
 *  THAT EXIST (an unknown id is absent). Runs in the caller's tenant tx; locks the item rows `FOR UPDATE` so two
 *  concurrent recomputes (cron tick vs cancel) serialise and the last writer wins with a correct value. */
export async function recomputeCarryForwardCounts(
  tx: DbClient,
  organizationId: string,
  actionItemIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, CarryForwardCountChange>> {
  const out = new Map<string, CarryForwardCountChange>();
  if (actionItemIds.length === 0) return out;
  const ids = [...new Set(actionItemIds)].sort();
  const stored = await tx
    .select({ id: ACT.id, count: ACT.meetingCarryForwardCount })
    .from(ACT)
    .where(and(eq(ACT.organizationId, organizationId), inArray(ACT.id, ids)))
    .orderBy(ACT.id)
    .for("update");
  if (stored.length === 0) return out;
  const derived = await tx
    .select({
      itemId: AGD.carriedFromActionItemId,
      n: sql<number>`count(distinct ${AGD.idgMeetingId})::int`,
    })
    .from(AGD)
    .innerJoin(MTG, eq(MTG.id, AGD.idgMeetingId))
    .where(
      and(
        eq(AGD.organizationId, organizationId),
        eq(AGD.kind, "carry_forward" as never),
        inArray(AGD.carriedFromActionItemId, ids),
        notInArray(MTG.status, [...NON_COUNTING_MEETING_STATUSES] as never),
      ),
    )
    .groupBy(AGD.carriedFromActionItemId);
  const derivedBy = new Map(derived.map((d) => [d.itemId as string, Number(d.n)]));
  for (const row of stored) {
    const current = derivedBy.get(row.id) ?? 0;
    out.set(row.id, { previous: row.count, current });
    if (current === row.count) continue;
    await tx
      .update(ACT)
      .set({
        meetingCarryForwardCount: current,
        version: sql`${ACT.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(ACT.id, row.id), eq(ACT.organizationId, organizationId)));
  }
  return out;
}

/** Re-derive the count of every action item the given meeting carried (call AFTER the meeting's status change,
 *  inside the same tx, from the CANCEL / RESCHEDULE paths). */
export async function recomputeCarryForwardCountsForMeeting(
  tx: DbClient,
  organizationId: string,
  meetingId: string,
  now: Date,
): Promise<ReadonlyMap<string, CarryForwardCountChange>> {
  const carried = await tx
    .select({ itemId: AGD.carriedFromActionItemId })
    .from(AGD)
    .where(
      and(
        eq(AGD.organizationId, organizationId),
        eq(AGD.idgMeetingId, meetingId),
        eq(AGD.kind, "carry_forward" as never),
      ),
    );
  return recomputeCarryForwardCounts(
    tx,
    organizationId,
    carried.flatMap((c) => (c.itemId === null ? [] : [c.itemId])),
    now,
  );
}
