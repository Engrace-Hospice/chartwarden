// apps/backend/src/modules/08-encounters/drafting/care-plan-links.ts — `encounter_care_plan_link` reads and writes for the visit-note
// draft (S1 PR C2b1). The rules (what to write) are the pure planners in care-plan-refs.ts; this only loads the rows and executes the plan
// on the caller's transaction. The application role holds no DELETE on any M8 table, so a removal is a soft `removed_at`.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  type CarePlanElement,
  type LinkOp,
  type LinkRowState,
  planLinks,
  planRemovals,
  removedElementIdsOf,
} from "./care-plan-refs";
import type { DraftEncounterRow } from "./draft-store";

const L = schema.encounterCarePlanLinks;

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

/** Goal and intervention ids this encounter's draft leaves out (a removed link and no live one). */
export async function removedCarePlanElementIds(
  tx: DbClient,
  encounterId: string,
): Promise<ReadonlySet<string>> {
  return removedElementIdsOf(await loadLinkRows(tx, encounterId));
}

const elementColumns = (element: CarePlanElement) =>
  element.kind === "goal" ? { goalId: element.id } : { interventionId: element.id };

async function execute(
  tx: DbClient,
  encounter: DraftEncounterRow,
  ops: readonly LinkOp[],
  removal: { readonly by: string; readonly at: Date } | null,
): Promise<number> {
  for (const op of ops) {
    if (op.op === "remove_live") {
      await tx
        .update(L)
        .set({ removedAt: removal?.at, removedByMembershipId: removal?.by })
        .where(and(eq(L.encounterId, encounter.id), inArray(L.id, [...op.rowIds])));
      continue;
    }
    await tx.insert(L).values({
      organizationId: encounter.organizationId,
      providerEntityId: encounter.providerEntityId,
      locationId: encounter.locationId,
      encounterId: encounter.id,
      ...elementColumns(op.element),
      // An already-removed tombstone carries both columns or neither (the table's removal-consistent CHECK).
      ...(op.op === "insert_removed"
        ? { removedAt: removal?.at, removedByMembershipId: removal?.by }
        : {}),
    });
  }
  return ops.length;
}

export async function linkElements(
  tx: DbClient,
  encounter: DraftEncounterRow,
  elements: readonly CarePlanElement[],
): Promise<number> {
  return execute(tx, encounter, planLinks(await loadLinkRows(tx, encounter.id), elements), null);
}

export async function removeElements(
  tx: DbClient,
  encounter: DraftEncounterRow,
  elements: readonly CarePlanElement[],
  removedBy: string,
  now: Date,
): Promise<number> {
  const ops = planRemovals(await loadLinkRows(tx, encounter.id), elements);
  return execute(tx, encounter, ops, { by: removedBy, at: now });
}
