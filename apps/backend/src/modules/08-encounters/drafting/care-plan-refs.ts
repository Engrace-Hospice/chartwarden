// apps/backend/src/modules/08-encounters/drafting/care-plan-refs.ts — the care-plan link rules of a visit-note draft (S1 PR C2b1;
// ADR-0114 VN-D8, design §3.2 "Care-plan items"). Pure: the rows go in, the writes to make come out; the Drizzle store
// (care-plan-links.ts) only executes them.
//
//   * Confirming a section links its care-plan elements to the encounter, idempotently: an element that already has a LIVE link gets none.
//   * Deselecting a section removes them: a live link is soft-removed (`removed_at`, `removed_by_membership_id`; the application role
//     holds no DELETE), and an element that was never linked gets an already-removed TOMBSTONE row, so the next recomputed draft (a
//     re-open, another device) still leaves it out. An element whose links are already all removed needs nothing.
//   * A note never changes the care plan: these rows join an encounter to M7 elements, and nothing here writes an M7 table.
//   * An element is "removed" for the draft only while it has a removed row and no live one: re-linking it through the picker
//     (a new live row) brings it back.
//
// ponytail: a link row naming several elements at once (the picker writes one element per row; the table allows more) is treated
// as a link to each of them, so removing one removes the row; a multi-element row would need a split, and none is written today.
import type { DraftSourceRef } from "@chartwarden/hearthnote";

/** One `encounter_care_plan_link` row, as far as these rules read it. */
export interface LinkRowState {
  readonly id: string;
  readonly goalId: string | null;
  readonly interventionId: string | null;
  readonly removedAt: Date | null;
}

/** A care-plan goal or intervention (the two kinds a draft section is built from). */
export interface CarePlanElement {
  readonly kind: "goal" | "intervention";
  readonly id: string;
}

export type LinkOp =
  | { readonly op: "insert_live"; readonly element: CarePlanElement }
  | { readonly op: "insert_removed"; readonly element: CarePlanElement }
  | {
      readonly op: "remove_live";
      readonly element: CarePlanElement;
      readonly rowIds: readonly string[];
    };

const ELEMENT_OF_KIND: Readonly<Record<string, CarePlanElement["kind"]>> = {
  care_plan_goal: "goal",
  care_plan_intervention: "intervention",
};

/** Whether a draft source is a care-plan element (the only sources a note can link or unlink). */
export const isCarePlanRef = (ref: DraftSourceRef): boolean => ref.kind in ELEMENT_OF_KIND;

/** The care-plan elements among a section's sources, in order. */
export function carePlanElementsOf(refs: readonly DraftSourceRef[]): CarePlanElement[] {
  return refs.flatMap((ref): CarePlanElement[] => {
    const kind = ELEMENT_OF_KIND[ref.kind];
    return kind === undefined ? [] : [{ kind, id: ref.id }];
  });
}

const rowsOf = (rows: readonly LinkRowState[], element: CarePlanElement): LinkRowState[] =>
  rows.filter((r) => (element.kind === "goal" ? r.goalId : r.interventionId) === element.id);

/** Goal and intervention ids whose links on this encounter were removed and not re-made: the ones a draft leaves out. */
export function removedElementIdsOf(rows: readonly LinkRowState[]): ReadonlySet<string> {
  const live = new Set<string>();
  const removed = new Set<string>();
  for (const row of rows) {
    for (const id of [row.goalId, row.interventionId]) {
      if (id !== null) (row.removedAt === null ? live : removed).add(id);
    }
  }
  return new Set([...removed].filter((id) => !live.has(id)));
}

/** Confirming: one live link per element that has none yet. */
export function planLinks(
  rows: readonly LinkRowState[],
  elements: readonly CarePlanElement[],
): LinkOp[] {
  return elements.flatMap((element): LinkOp[] =>
    rowsOf(rows, element).some((r) => r.removedAt === null) ? [] : [{ op: "insert_live", element }],
  );
}

/** Deselecting: soft-remove an element's live links, or tombstone an element that was never linked. */
export function planRemovals(
  rows: readonly LinkRowState[],
  elements: readonly CarePlanElement[],
): LinkOp[] {
  return elements.flatMap((element): LinkOp[] => {
    const own = rowsOf(rows, element);
    const live = own.filter((r) => r.removedAt === null);
    if (live.length > 0) return [{ op: "remove_live", element, rowIds: live.map((r) => r.id) }];
    return own.length === 0 ? [{ op: "insert_removed", element }] : [];
  });
}
