// apps/backend/src/modules/08-encounters/drafting/discipline-plan-links.ts — `encounter_discipline_plan_link` reads and writes for the social-work and
// chaplain visit-note draft (ADR-0114 S4b, VN-D58, VN-D59). The rules (what to write) are the M7 care-plan planners in care-plan-refs.ts, which read goal
// and intervention ids only; this loads the rows and executes the plan on the caller's transaction, as care-plan-links.ts does for M7. The application role
// holds no DELETE on any M8 table, so a removal is a soft `removed_at`. A live row means "kept in this visit's statement of the plan", never "addressed".
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";
import {
  type CarePlanElement,
  type LinkOp,
  type LinkRowState,
  planLinks,
  planRemovals,
  removedElementIdsOf,
  rowsOf,
} from "./care-plan-refs";
import type { DraftEncounterRow } from "./draft-store";

const L = schema.encounterDisciplinePlanLinks;

/**
 * The most link rows one encounter may hold, live and removed together. A removed row is never revived (keeping the element again is a new row), so an author
 * who alternately keeps and leaves out one element adds a row per cycle, and every read of the draft and every write loads them all (a write inside the
 * encounter's row lock). A real plan holds a few dozen goals and interventions and each is toggled a few times: ten times a generous fifty elements is out
 * of any honest visit's reach, and a script is stopped at a bounded cost. The audit rows are bounded with it (an insert and at most two updates per row).
 */
export const MAX_DISCIPLINE_PLAN_LINK_ROWS = 500;

/**
 * Refuses a plan whose RE-KEEPS would take the table past the cap, naming no element. Only a re-keep (a new live row for an element that already has rows)
 * grows the table without the plan's own size bounding it: a first row of an element, live or removed, is bounded by the plan, and a removal of a live row
 * adds none. So the clinician can always leave an element out and a section can always be confirmed or deselected; the table stays under the cap plus the plan.
 */
function assertRoomFor(rows: readonly LinkRowState[], ops: readonly LinkOp[]): void {
  const rekept = ops.filter((op) => op.op === "insert_live" && rowsOf(rows, op.element).length > 0);
  if (rekept.length > 0 && rows.length + rekept.length > MAX_DISCIPLINE_PLAN_LINK_ROWS) {
    throw new EncounterStateError(
      "DISCIPLINE_PLAN_LINK_LIMIT",
      "This visit has recorded as many plan keep and leave-out changes as it can hold, so nothing was changed.",
    );
  }
}

async function loadLinkRows(tx: DbClient, encounterId: string): Promise<LinkRowState[]> {
  return tx
    .select({
      id: L.id,
      goalId: L.goalId,
      interventionId: L.interventionId,
      removedAt: L.removedAt,
    })
    .from(L)
    .where(eq(L.encounterId, encounterId));
}

/** M15 goal and intervention ids this encounter's draft leaves out (a removed link and no live one). */
export async function removedDisciplinePlanElementIds(
  tx: DbClient,
  encounterId: string,
): Promise<ReadonlySet<string>> {
  return removedElementIdsOf(await loadLinkRows(tx, encounterId));
}

const elementColumns = (element: CarePlanElement) =>
  element.kind === "goal" ? { goalId: element.id } : { interventionId: element.id };

/**
 * Loads the encounter's link rows, plans against them (refusing a plan the row cap cannot hold) and executes it in at most three further statements,
 * however many elements it names (the encounter's row lock is held throughout, so a round trip per element would hold it for as long as the plan is
 * long): one UPDATE for every soft-removal, one INSERT for the new live links and one for the already-removed tombstones. Every row states
 * `part2_derived` (no default): the section's verdict, so an element of a Part 2 derived section is filed as Part 2 and its ids are withheld from the
 * audit image.
 */
async function execute(
  tx: DbClient,
  encounter: DraftEncounterRow,
  planOps: (rows: readonly LinkRowState[]) => readonly LinkOp[],
  part2Derived: boolean,
  removal: { readonly by: string; readonly at: Date } | null,
): Promise<number> {
  const rows = await loadLinkRows(tx, encounter.id);
  const ops = planOps(rows);
  assertRoomFor(rows, ops);
  const rowIds = ops.flatMap((op) => (op.op === "remove_live" ? op.rowIds : []));
  const link = (element: CarePlanElement) => ({
    organizationId: encounter.organizationId,
    providerEntityId: encounter.providerEntityId,
    locationId: encounter.locationId,
    encounterId: encounter.id,
    part2Derived,
    ...elementColumns(element),
  });
  const live = ops.flatMap((op) => (op.op === "insert_live" ? [link(op.element)] : []));
  // An already-removed tombstone carries both removal columns or neither (the table's removal-consistent CHECK).
  const tombstones = ops.flatMap((op) =>
    op.op === "insert_removed"
      ? [{ ...link(op.element), removedAt: removal?.at, removedByMembershipId: removal?.by }]
      : [],
  );
  if (rowIds.length > 0) {
    await tx
      .update(L)
      .set({ removedAt: removal?.at, removedByMembershipId: removal?.by })
      .where(and(eq(L.encounterId, encounter.id), inArray(L.id, rowIds)));
  }
  if (live.length > 0) await tx.insert(L).values(live);
  if (tombstones.length > 0) await tx.insert(L).values(tombstones);
  return ops.length;
}

/**
 * Raises to Part 2 the rows of these elements that were filed while the verdict was lower (a plan revision since marked the element SUD related): a
 * flag only ever goes up, so no later write on the row (an update, or the eraser's delete) files its element id in the plain audit class. One statement,
 * and only for a Part 2 verdict; it runs before the change itself so that change's own audit images are already scrubbed.
 */
async function raisePart2Flag(
  tx: DbClient,
  encounterId: string,
  elements: readonly CarePlanElement[],
  part2Derived: boolean,
): Promise<void> {
  if (!part2Derived) return;
  const idsOf = (kind: CarePlanElement["kind"]) =>
    elements.filter((element) => element.kind === kind).map((element) => element.id);
  const goalIds = idsOf("goal");
  const interventionIds = idsOf("intervention");
  const named = or(
    goalIds.length > 0 ? inArray(L.goalId, goalIds) : undefined,
    interventionIds.length > 0 ? inArray(L.interventionId, interventionIds) : undefined,
  );
  if (named === undefined) return;
  await tx
    .update(L)
    .set({ part2Derived: true })
    .where(and(eq(L.encounterId, encounterId), eq(L.part2Derived, false), named));
}

export async function linkDisciplineElements(
  tx: DbClient,
  encounter: DraftEncounterRow,
  elements: readonly CarePlanElement[],
  part2Derived: boolean,
): Promise<number> {
  if (elements.length === 0) return 0; // a section with no M15 element (the other templates') costs no read
  await raisePart2Flag(tx, encounter.id, elements, part2Derived);
  return execute(tx, encounter, (rows) => planLinks(rows, elements), part2Derived, null);
}

export async function removeDisciplineElements(
  tx: DbClient,
  encounter: DraftEncounterRow,
  elements: readonly CarePlanElement[],
  part2Derived: boolean,
  removedBy: string,
  now: Date,
): Promise<number> {
  if (elements.length === 0) return 0;
  await raisePart2Flag(tx, encounter.id, elements, part2Derived);
  return execute(tx, encounter, (rows) => planRemovals(rows, elements), part2Derived, {
    by: removedBy,
    at: now,
  });
}
