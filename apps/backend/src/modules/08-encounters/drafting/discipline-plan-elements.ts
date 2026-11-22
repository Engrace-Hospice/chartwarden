// apps/backend/src/modules/08-encounters/drafting/discipline-plan-elements.ts — the response of the per-element routes of a social-work or chaplain visit's
// drafted plan (ADR-0114 S4b, VN-D60): which of the discipline's goals and interventions the visit keeps. Pure shapes and the template predicate; the read is
// `readDisciplinePlanElements` (inputs.ts) and the write the store's `linkDisciplinePlan` / `removeDisciplinePlan`. A clinician sees only what the plan hands
// their own Part 2 verdict, so nothing here can name an element they may not read.
import { draftSourceNeeds } from "@chartwarden/hearthnote";
import { EncounterStateError } from "../lifecycle/errors";
import type { DisciplinePlanElement } from "./inputs";
import type { DraftEncounter } from "./ports";

/** One element as the picker shows it: its words and whether the visit keeps it. The Part 2 flag is the row's, never the wire's. */
export interface DisciplinePlanElementView {
  readonly elementId: string;
  readonly kind: "goal" | "intervention";
  readonly text: string;
  readonly kept: boolean;
}

export interface DisciplinePlanElementsView {
  /** The encounter's patient: the audited read is accountable against it (§164.528). */
  readonly patientId: string;
  readonly elements: readonly DisciplinePlanElementView[];
}

export function disciplinePlanElementsView(
  encounter: DraftEncounter,
  elements: readonly DisciplinePlanElement[],
): DisciplinePlanElementsView {
  return {
    patientId: encounter.patientId,
    elements: elements.map(({ elementId, kind, text, kept }) => ({ elementId, kind, text, kept })),
  };
}

/**
 * Only a visit whose note is drafted from the discipline's own plan (a social worker's or a chaplain's) has elements to keep or leave out: any other
 * template is refused 422, as a section the template does not have is. (It says nothing a caller could not learn from the template.)
 */
export function assertDraftsFromDisciplinePlan(encounter: DraftEncounter): void {
  if (!draftSourceNeeds(encounter.encounterType, encounter.discipline).disciplinePlan) {
    throw new EncounterStateError(
      "UNKNOWN_TEMPLATE_SECTION",
      "this visit's note is not drafted from the discipline's plan",
    );
  }
}
