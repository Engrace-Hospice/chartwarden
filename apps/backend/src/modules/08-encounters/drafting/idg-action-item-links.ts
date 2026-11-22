// apps/backend/src/modules/08-encounters/drafting/idg-action-item-links.ts — `encounter_idg_action_item_link` reads and writes for the IDG follow-up visit's
// draft (ADR-0114 S5b, VN-D64, VN-D67): the ONE M14 action item the author linked the visit to. A live row means "this visit follows that team follow-up
// up" and nothing else: M14's own auto-close does not read it, and nothing here writes an M14 table. The application role holds no DELETE on any M8 table, so
// a removal is a soft `removed_at`; a different item REPLACES the live one (the old row is removed, a new one filed), which the table's one-live-row index
// requires in that order. The rules (what to write) are pure (`planIdgLink`); this loads the rows and executes the plan on the caller's transaction.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, isNull } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";
import type { DraftEncounterRow, IdgLinkTarget } from "./draft-store";

const L = schema.encounterIdgActionItemLinks;

/**
 * The most link rows one encounter may hold, live and removed together. A removed row is never revived (linking an item again is a new row), so an author
 * who alternately links and clears items adds a row per change, and every read of the draft loads the live one while every write loads them all (inside the
 * encounter's row lock). One live row, a handful of candidates and a few changes each: a hundred is out of any honest visit's reach, and a script is stopped
 * at a bounded cost. The audit rows are bounded with it (an insert and at most two updates per row).
 */
export const MAX_IDG_ACTION_ITEM_LINK_ROWS = 100;

/** One link row as the rules see it. */
export interface IdgLinkRowState {
  readonly id: string;
  readonly actionItemId: string;
  readonly removedAt: Date | null;
}

/** The plan for one change: which live row to remove, which rows to raise to Part 2, and which new live row to file. Pure data. */
export interface IdgLinkPlan {
  readonly removeRowId: string | null;
  readonly raisePart2OfItems: readonly string[];
  readonly insert: IdgLinkTarget | null;
}

/**
 * Plans one change against the encounter's rows. Idempotent: naming the live item changes nothing, and clearing with no live row changes nothing. The Part 2
 * flag only ever goes up: the rows of an item whose verdict is Part 2 that were filed lower (the patient was flagged since) are raised first, so no later write
 * on them, nor the eraser's delete, files the action item id in the plain audit class. `currentPart2Derived` is the verdict for the live item being left
 * (the service passes `true` when it cannot tell, which fails closed).
 */
export function planIdgLink(
  rows: readonly IdgLinkRowState[],
  target: IdgLinkTarget | null,
  currentPart2Derived: boolean,
): IdgLinkPlan {
  const live = rows.find((row) => row.removedAt === null);
  if (target !== null && live?.actionItemId === target.actionItemId) {
    return {
      removeRowId: null,
      raisePart2OfItems: target.part2Derived ? [target.actionItemId] : [],
      insert: null,
    };
  }
  return {
    removeRowId: live?.id ?? null,
    raisePart2OfItems: [
      ...(live !== undefined && currentPart2Derived ? [live.actionItemId] : []),
      ...(target?.part2Derived ? [target.actionItemId] : []),
    ],
    insert: target,
  };
}

/**
 * Refuses a plan whose RE-LINK would take the table past the cap, naming no item. Only a re-link (a new live row for an item that already has rows) grows
 * the table without the candidates bounding it: a first row of an item is bounded by the candidate list, and a clear adds none. So the author can always
 * clear the link, and the first time an item is linked is never refused.
 */
function assertRoomFor(rows: readonly IdgLinkRowState[], plan: IdgLinkPlan): void {
  const relinked =
    plan.insert !== null && rows.some((r) => r.actionItemId === plan.insert?.actionItemId);
  if (relinked && rows.length + 1 > MAX_IDG_ACTION_ITEM_LINK_ROWS) {
    throw new EncounterStateError(
      "IDG_ACTION_ITEM_LINK_LIMIT",
      "This visit has recorded as many follow-up link changes as it can hold, so nothing was changed.",
    );
  }
}

async function loadLinkRows(tx: DbClient, encounterId: string): Promise<IdgLinkRowState[]> {
  return tx
    .select({ id: L.id, actionItemId: L.actionItemId, removedAt: L.removedAt })
    .from(L)
    .where(eq(L.encounterId, encounterId));
}

/** The M14 action item this encounter's draft is linked to (its one live row), or `null`. One narrow read: the draft routes make it on every read. */
export async function liveIdgActionItemId(
  tx: DbClient,
  encounterId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ actionItemId: L.actionItemId })
    .from(L)
    .where(and(eq(L.encounterId, encounterId), isNull(L.removedAt)))
    .limit(1);
  return row?.actionItemId ?? null;
}

/**
 * Links the encounter to `target` (replacing any other live item) or clears the link (`null`), executing `planIdgLink` in at most three statements: the
 * Part 2 raises, the soft removal of the live row, then the insert of the new live row (in that order: the one-live-row index). Returns whether anything changed.
 * The author's membership stamps both the link and the removal.
 */
export async function setIdgActionItemLink(
  tx: DbClient,
  encounter: DraftEncounterRow,
  target: IdgLinkTarget | null,
  currentPart2Derived: boolean,
  by: string,
  now: Date,
): Promise<boolean> {
  const rows = await loadLinkRows(tx, encounter.id);
  const plan = planIdgLink(rows, target, currentPart2Derived);
  assertRoomFor(rows, plan);
  for (const actionItemId of plan.raisePart2OfItems) {
    await tx
      .update(L)
      .set({ part2Derived: true })
      .where(
        and(
          eq(L.encounterId, encounter.id),
          eq(L.actionItemId, actionItemId),
          eq(L.part2Derived, false),
        ),
      );
  }
  if (plan.removeRowId !== null) {
    await tx
      .update(L)
      .set({ removedAt: now, removedByMembershipId: by })
      .where(and(eq(L.encounterId, encounter.id), eq(L.id, plan.removeRowId)));
  }
  if (plan.insert !== null) {
    await tx.insert(L).values({
      organizationId: encounter.organizationId,
      providerEntityId: encounter.providerEntityId,
      locationId: encounter.locationId,
      encounterId: encounter.id,
      actionItemId: plan.insert.actionItemId,
      linkedByMembershipId: by,
      part2Derived: plan.insert.part2Derived,
    });
  }
  return plan.removeRowId !== null || plan.insert !== null;
}
