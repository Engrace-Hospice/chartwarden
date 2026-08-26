// apps/backend/__tests__/_hearthnote-fixtures.ts — the minimum documentation that satisfies the §2.6
// Layer-3 gate's check 1 (#121), shared by every M8 suite that finalizes or signs.
//
// Before the gate was real, a suite could sign an encounter it had documented nothing on — which is
// how eight of them did, including the repo's own "§7.1 RN routine visit happy path". The fix is not to
// weaken the gate for tests: it is for a suite whose subject is the LIFECYCLE to write the note first,
// exactly as a clinician does, so the only suites that stay red are the ones asserting a refusal.
import { resolveTemplate } from "@wardenx/hearthnote";
import type { EncounterDiscipline, EncounterType } from "@wardenx/types";

/** A param-free corpus code, so a fixture never has to carry slot values to assemble. */
export const FIXTURE_VOCAB_CODE = "nv.cv.stable";

/**
 * One selection per REQUIRED section of the (encounterType × discipline) template — the smallest tree
 * that passes check 1. Optional sections are deliberately left empty: a fixture that populated them too
 * would stop proving that only the required ones are load-bearing.
 */
export function requiredSectionSelections(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): { sections: Array<{ sectionId: string; entries: Array<{ code: string }> }> } {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new Error(`no HearthNote template for '${encounterType} × ${discipline}'`);
  }
  return {
    sections: template.sections
      .filter((s) => s.required)
      .map((s) => ({ sectionId: s.id, entries: [{ code: FIXTURE_VOCAB_CODE }] })),
  };
}

/** One populated section — the smallest tree that passes the addendum gate (which has no template). */
export const ADDENDUM_SELECTIONS = {
  sections: [{ sectionId: "assessment", entries: [{ code: FIXTURE_VOCAB_CODE }] }],
};
