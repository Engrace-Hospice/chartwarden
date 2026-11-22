// apps/backend/src/modules/08-encounters/drafting/discipline-plan-refs.ts — which sources of a drafted section are M15 plan elements a social-work or chaplain
// visit can keep or leave out (ADR-0114 S4b, VN-D58, VN-D59). Pure. The link RULES are the M7 care-plan ones (care-plan-refs.ts: `planLinks`,
// `planRemovals`, `removedElementIdsOf`), which only read goal and intervention ids; this module says which refs they are applied to, and the Drizzle store
// (discipline-plan-links.ts) executes them against `encounter_discipline_plan_link`. A link says the clinician KEPT the element in this visit's statement
// of the plan; it never says the visit addressed it, and nothing here writes an M15 table.
import type { DraftSourceRef } from "@chartwarden/hearthnote";
import type { CarePlanElement } from "./care-plan-refs";

const ELEMENT_OF_KIND: Readonly<Record<string, CarePlanElement["kind"]>> = {
  discipline_plan_goal: "goal",
  discipline_plan_intervention: "intervention",
};

/** Whether a draft source is an M15 plan element (the only discipline-plan sources a note can keep or leave out). */
export const isDisciplinePlanRef = (ref: DraftSourceRef): boolean => ref.kind in ELEMENT_OF_KIND;

/** The M15 plan elements among a section's sources, in order. */
export function disciplinePlanElementsOf(refs: readonly DraftSourceRef[]): CarePlanElement[] {
  return refs.flatMap((ref): CarePlanElement[] => {
    const kind = ELEMENT_OF_KIND[ref.kind];
    return kind === undefined ? [] : [{ kind, id: ref.id }];
  });
}
