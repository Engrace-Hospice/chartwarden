// apps/backend/src/modules/08-encounters/routes/visit-reasons.ts — the "Reason for Visit" choices for one
// (encounter type × discipline) pair, and the selection that records one (WF09 step 2).
//
// PURE: platform data derived from `@chartwarden/narrative-vocab`, identical for every patient. It exists so a
// clinician starting a visit on site can choose the reason BEFORE the encounter exists (the New Encounter
// form), without the browser carrying a copy of the corpus: the same `entriesFor` scoping that builds the
// authoring menu builds this list, so what is offered here is exactly what the composer would offer.
import { entriesFor } from "@chartwarden/narrative-vocab";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import type { SelectionSectionInput } from "./service";

/** The template section a visit reason is recorded in. */
export const REASON_SECTION_ID = "chief_concern";

export interface VisitReasonChoice {
  readonly code: string;
  readonly label: string;
}

/** The reasons offered on `encounterType` by `discipline`, in the corpus's stable order. */
export function visitReasonsFor(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): readonly VisitReasonChoice[] {
  return entriesFor(encounterType, discipline)
    .filter((e) => e.category === "visit_reason")
    .map((e) => ({ code: e.code, label: e.label }));
}

/**
 * The Reason for Visit section holding `reasonCode`, for a draft being created with its reason already
 * chosen. Refuses a code this pair is not offered (422) BEFORE the draft exists, so a bad request cannot
 * leave a draft behind.
 */
export function reasonSectionFor(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  reasonCode: string,
): SelectionSectionInput {
  if (!visitReasonsFor(encounterType, discipline).some((r) => r.code === reasonCode)) {
    throw new EncounterStateError(
      "INVALID_SELECTION",
      `'${reasonCode}' is not a reason for a ${discipline} ${encounterType} visit`,
    );
  }
  return { sectionId: REASON_SECTION_ID, entries: [{ code: reasonCode }] };
}
