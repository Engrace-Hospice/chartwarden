// packages/narrative-vocab/src/dyspnea-assessment-entries.ts — the statements behind the composer's "Dyspnea assessment" helper.
//
// Under "Symptom impact — dyspnea limiting function" the composer shows a helper that lets the clinician record what the dyspnea
// assessment is made of: the intensity, onset, when it occurs, what brings it on, what relieves it, what it feels like, the
// distress or anxiety with it and its effect on function, the non-drug measures and the response to the measures tried, the
// patient's own acceptable dyspnea level, the score and the change since the last visit, the signs observed in a patient who cannot
// self-report, and the decision about the plan of care. Each is ONE statement with ONE small slot, so the note states exactly what
// was recorded and nothing else; an item the clinician did not record has no sentence (an empty slot would assemble into
// "Dyspnea onset: ", which is why this is not one statement with optional slots).
//
// The effect on function is also the wording of the existing "dyspnea limiting function" statement (`nv.sym.dyspnea_impact`), which
// is unchanged; the `function` statement here is the clinician's own words about it. Which of the statements document which of the
// eight characteristics, and the advisory rules built on them, are in `@chartwarden/types` (`dyspnea-assessment.ts`);
// `__tests__/dyspnea-assessment-corpus.test.ts` pins the two.
//
// There is NO statement for oxygen, for teaching, or for an observation scale: no source defines a dyspnea cut-off, and the corpus
// records what the clinician observed in words, never a score that a rule could act on.
//
// The corpus is DATA with D11-pinned bytes: the choice strings below are interpolated verbatim and are copied, not imported,
// from `@chartwarden/types`, so editing a constant there can never reword a shipped phrase.
//
// The phrases state what the clinician typed or chose and carry no clinical judgement. Lora, RN signed the sheet's section 7 off as a
// whole on 2026-11-25 (per-row boxes blank); `CORPUS_CLINICAL_REVIEW` stays `pending` and gates only the draft switch. Sources for the content: docs/research/DYSPNEA_ASSESSMENT_AND_PLAN_OF_CARE_RESEARCH.md.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { SlotSpec, VocabEntry } from "./types";

// The same scoping as the dyspnea statement they hang off (`nv.sym.dyspnea_impact`); a test pins that they stay equal.
const DISCIPLINES: readonly EncounterDiscipline[] = ["rn", "lpn", "md", "np"];
const ENCOUNTER_TYPES: readonly EncounterType[] = [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "face_to_face",
  "lpn_visit",
];

const score = (label: string): SlotSpec => ({ kind: "integer", min: 0, max: 10, label });

function statement(
  code: string,
  label: string,
  phrase: string,
  slotSpecs?: Readonly<Record<string, SlotSpec>>,
): VocabEntry {
  return {
    code,
    label,
    phrase,
    category: "symptom_impact",
    disciplines: DISCIPLINES,
    encounterTypes: ENCOUNTER_TYPES,
    ...(slotSpecs === undefined ? {} : { slotSpecs }),
  };
}

export const DYSPNEA_ASSESSMENT_VOCABULARY: readonly VocabEntry[] = [
  // ── the characteristics: intensity, then the clinician's own words ─────────────────────────────────────────
  statement(
    "nv.sym.dyspnea_score",
    "Dyspnea assessment — intensity",
    "Dyspnea intensity: ${dyspnea_score} of 10",
    { dyspnea_score: score("Dyspnea intensity (0–10)") },
  ),
  statement(
    "nv.sym.dyspnea_onset",
    "Dyspnea assessment — onset",
    "Dyspnea onset: ${dyspnea_onset}",
  ),
  statement(
    "nv.sym.dyspnea_setting",
    "Dyspnea assessment — when it occurs",
    "Dyspnea occurs ${dyspnea_setting}",
    {
      dyspnea_setting: {
        kind: "choice",
        options: ["at rest", "on exertion", "at rest and on exertion", "at other times"],
        label: "When dyspnea occurs",
      },
    },
  ),
  statement(
    "nv.sym.dyspnea_triggers",
    "Dyspnea assessment — what brings it on or worsens it",
    "Dyspnea is brought on or made worse by ${dyspnea_triggers}",
  ),
  statement(
    "nv.sym.dyspnea_relieved_by",
    "Dyspnea assessment — what relieves it",
    "Dyspnea is relieved by ${dyspnea_relieved_by}",
  ),
  statement(
    "nv.sym.dyspnea_quality",
    "Dyspnea assessment — quality",
    "Dyspnea quality: ${dyspnea_quality}",
  ),
  statement(
    "nv.sym.dyspnea_distress",
    "Dyspnea assessment — distress or anxiety",
    "Distress or anxiety with dyspnea: ${dyspnea_distress}",
  ),
  statement(
    "nv.sym.dyspnea_function",
    "Dyspnea assessment — effect on function",
    "Effect of dyspnea on function: ${dyspnea_function}",
  ),

  // ── measures tried and the response to them ────────────────────────────────────────────────────────────
  statement(
    "nv.sym.dyspnea_nondrug",
    "Dyspnea assessment — non-drug measures",
    "Non-drug measures for dyspnea: ${dyspnea_nondrug}",
  ),
  statement(
    "nv.sym.dyspnea_response",
    "Dyspnea assessment — response to the measures tried",
    "Dyspnea response to measures: ${dyspnea_response}",
    {
      dyspnea_response: {
        kind: "choice",
        options: ["complete relief", "partial relief", "no relief", "no measures tried"],
        label: "Response to the measures tried",
      },
    },
  ),

  // ── the patient's goal and the change since the last visit ─────────────────────────────────────────────
  statement(
    "nv.sym.dyspnea_goal",
    "Dyspnea assessment — the patient's acceptable dyspnea level",
    "${patient}'s acceptable dyspnea level is ${dyspnea_goal} of 10",
    { dyspnea_goal: score("Acceptable dyspnea level (0–10)") },
  ),
  statement(
    "nv.sym.dyspnea_last_score",
    "Dyspnea assessment — dyspnea score at the last visit",
    "Dyspnea at the last visit was ${dyspnea_last_score} of 10",
    { dyspnea_last_score: score("Dyspnea score at the last visit (0–10)") },
  ),
  statement(
    "nv.sym.dyspnea_change",
    "Dyspnea assessment — change since the last visit",
    "Change in dyspnea since the last visit: ${dyspnea_change}",
    {
      dyspnea_change: {
        kind: "choice",
        options: ["improved", "unchanged", "worsened", "new dyspnea"],
        label: "Change since the last visit",
      },
    },
  ),

  // ── a patient who cannot self-report ───────────────────────────────────────────────────────────────────
  statement(
    "nv.sym.dyspnea_nonverbal",
    "Dyspnea assessment — cannot self-report, signs observed",
    "${patient} is unable to self-report dyspnea; signs observed: ${dyspnea_nonverbal}",
  ),

  // ── the clinician's decision about the plan of care ────────────────────────────────────────────────────
  statement(
    "nv.sym.dyspnea_plan_decision",
    "Dyspnea assessment — plan of care decision",
    "Plan of care for dyspnea: ${dyspnea_plan_decision}",
    {
      dyspnea_plan_decision: {
        kind: "choice",
        options: [
          "no change to the current plan of care",
          "physician notified",
          "IDG plan-of-care review requested",
          "physician notified and IDG plan-of-care review requested",
        ],
        label: "Plan of care decision",
      },
    },
  ),
];
