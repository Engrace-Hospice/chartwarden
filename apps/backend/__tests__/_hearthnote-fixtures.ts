// apps/backend/__tests__/_hearthnote-fixtures.ts — the minimum documentation that satisfies the §2.6
// Layer-3 gate's checks 1 and 2 (#121, #125), shared by every M8 suite that finalizes or signs.
//
// Before check 1 was real, a suite could sign an encounter it had documented nothing on — which is how
// eight of them did, including the repo's own "§7.1 RN routine visit happy path". The fix is not to
// weaken the gate for tests: it is for a suite whose subject is the LIFECYCLE to write the note first,
// exactly as a clinician does, so the only suites that stay red are the ones asserting a refusal. Check
// 2 (#125) reopened the same question for VITALS: every `draft()` helper across the M8 live suite
// documents sections but captured none, so the moment check 2 went live every finalize/sign case for a
// vitals-requiring pair would have failed the same way — `requiredVitalsCapture` is that fix's vitals
// half, built to the SAME rule (`requiredVitalsFor`'s own answer, never a hand-guessed one).
import { type VitalField, requiredVitalsFor, resolveTemplate } from "@chartwarden/hearthnote";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { VitalsInput } from "../src/modules/08-encounters/authoring/index";

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

/** A normal-range payload field for every §2.6 check-2 {@link VitalField} — the escape-hatch-free way
 *  to satisfy the roster (a live suite testing the ESCAPE HATCH captures its own partial input). */
const NORMAL_VITALS_BY_FIELD: Readonly<Record<VitalField, VitalsInput>> = {
  bp: { bpSystolic: 118, bpDiastolic: 76 },
  heartRate: { heartRate: 72 },
  respiratoryRate: { respiratoryRate: 16 },
  temperature: { temperature: "98.6", temperatureUnit: "f" },
  spo2: { spo2: 98 },
  pain: { painScore: 0, painScale: "nrs_0_10" },
};

/**
 * §2.6 check 2's (#125) minimum satisfying `captureVitals` payload for a (type × discipline) pair, or
 * `null` when the resolved template requires none (matching `requiredVitalsFor`'s own answer — this
 * fixture never invents a requirement the gate itself would not have asked for).
 */
export function requiredVitalsCapture(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): VitalsInput | null {
  const template = resolveTemplate(encounterType, discipline);
  if (template === undefined) {
    throw new Error(`no HearthNote template for '${encounterType} × ${discipline}'`);
  }
  const roster = requiredVitalsFor(template);
  if (roster.length === 0) return null;
  return Object.assign({}, ...roster.map((field) => NORMAL_VITALS_BY_FIELD[field])) as VitalsInput;
}
