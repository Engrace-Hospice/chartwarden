// packages/hearthnote/__tests__/legacy-corpus-regression.test.ts — the "unchanged corpus" guard (S1 PR B).
//
// The draft corpus (`narrative-vocab@2026.11.0`) only APPENDS entries. Layer-1 determinism and the D11 pin
// both depend on a shipped phrase's bytes never changing, so this file pins the first 23 entries (the
// 2026.06.0 corpus) two ways: a SHA-256 over their JSON (every field, in order) and a golden narrative
// assembled from all of them. Both were captured from the code BEFORE the draft corpus was added, so they
// fail if any legacy entry, its order, or the assembler's rendering of it changes.
import { createHash } from "node:crypto";
import { VOCABULARY, VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import {
  type AssemblyContext,
  type SelectionState,
  assembleLayer1,
  resolveTemplate,
} from "../src/index";

const LEGACY_ENTRY_COUNT = 23;
const LEGACY_CORPUS_SHA256 = "e289c4c6f01fd11c207d91b513cc2e10209253bdea907613cae9bfb0188b2601";

const CONTEXT: AssemblyContext = {
  patient: "Jane Doe",
  serviceDate: "2026-06-21",
  location: "patient residence",
};

const PARAMS: Readonly<Record<string, string | number>> = {
  edema_grade: "2+",
  o2_lpm: 2,
  last_bm: "yesterday",
  wound_stage: 2,
  wound_site: "sacrum",
  assist_level: "one-person",
  pain_score: 3,
  ambulation_distance: "ten feet",
  teaching_topic: "repositioning",
  coping_status: "adequate",
  family_dynamics_note: "the family is engaged",
  faith_tradition: "Roman Catholic",
  spiritual_intervention: "prayer",
  adl_tasks: "bathing and grooming",
};

/** Every legacy entry, split over four routine-RN sections (assembly does not police categories). */
function legacySelection(): SelectionState {
  const legacy = VOCABULARY.slice(0, LEGACY_ENTRY_COUNT);
  const entries = (from: number, to: number) =>
    legacy.slice(from, to).map((e) => ({ code: e.code, params: PARAMS }));
  return {
    templateKey: "routine_visit:rn",
    vocabVersion: VOCAB_VERSION,
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [
      { sectionId: "assessment", entries: entries(0, 11) },
      { sectionId: "symptom_management", entries: entries(11, 14) },
      { sectionId: "interventions", entries: entries(14, 17) },
      { sectionId: "plan", entries: entries(17, 23), freeText: "Clinician free text, verbatim." },
    ],
  };
}

const GOLDEN_NARRATIVE = [
  "Assessment\nJane Doe is cardiovascularly stable with no chest pain or palpitations reported. Jane Doe has 2+ dependent edema in the bilateral lower extremities. Jane Doe's respirations are unlabored and lung sounds are clear to auscultation. Jane Doe reports dyspnea on exertion and uses oxygen at 2 L/min via nasal cannula. Jane Doe is alert and oriented to person, place, and time. Jane Doe demonstrates increased somnolence and is oriented to person only. Jane Doe reports an adequate appetite with no nausea, and the last bowel movement was yesterday. Jane Doe is continent of urine with no signs of retention or dysuria. Jane Doe's skin is intact, warm, and dry with no open areas noted. Jane Doe has a stage 2 pressure injury at the sacrum, dressed per orders. Jane Doe has limited mobility and requires one-person assistance with transfers.",
  "Symptom Management\nJane Doe's pain is well controlled at 3 of 10 on the current medication regimen. Jane Doe reports pain at 3 of 10 that limits participation in daily activities. Dyspnea limits Jane Doe's ability to ambulate beyond ten feet.",
  "Interventions\nThe medication regimen was reconciled with the caregiver and reviewed against the care plan. Caregiver education was provided on repositioning with return demonstration verbalized. Progress toward the care-plan goals was reviewed and Jane Doe remains appropriate for hospice.",
  "Plan and Next Visit\nJane Doe and family are coping with the prognosis with adequate support systems in place. Family dynamics were assessed; the family is engaged. A spiritual care assessment was completed and Jane Doe identifies as Roman Catholic. Supportive presence and prayer were provided at the bedside. Personal care was provided including bathing and grooming per the aide plan of care. I attest that I had a face-to-face encounter with the patient and that the clinical findings support a continued prognosis of six months or less if the terminal illness runs its normal course. Clinician free text, verbatim.",
].join("\n\n");

describe("legacy corpus (narrative-vocab@2026.06.0 entries) is unchanged", () => {
  it("the first 23 entries are byte-identical, in order", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(VOCABULARY.slice(0, LEGACY_ENTRY_COUNT)))
      .digest("hex");
    expect(digest).toBe(LEGACY_CORPUS_SHA256);
  });

  it("assembles every legacy entry to the same bytes as before the draft corpus", () => {
    const template = resolveTemplate("routine_visit", "rn");
    expect(template).toBeDefined();
    if (template === undefined) return;
    expect(assembleLayer1(template, legacySelection(), CONTEXT).narrative).toBe(GOLDEN_NARRATIVE);
  });
});
