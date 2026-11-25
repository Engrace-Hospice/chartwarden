// packages/narrative-vocab/src/pain-assessment-entries.ts — the statements behind the composer's "Pain assessment" helper.
//
// Under "Symptom impact — pain limiting function" the composer shows a helper that lets the clinician record what the pain
// assessment is made of: the HOPE characteristics (location, character, duration, frequency, what relieves or worsens it), the
// response to medication, side effects, the bowel regimen, an inability to take oral medication, nonverbal cues and the
// observation scale used, the patient's own acceptable pain level, the score and the change since the last visit, and the
// decision about the plan of care. Each is ONE statement with ONE small set of slots, so the note states exactly what was
// recorded and nothing else; a characteristic the clinician did not record has no sentence (an empty slot would assemble into
// "Pain location: ", which is why this is not one statement with optional slots).
//
// Severity is the pain score of the pain statement itself and the effect on function is that statement's own wording, so
// neither has an entry here. Which of the statements document which of the seven HOPE characteristics, and the advisory rules
// built on them, are in `@chartwarden/types` (`pain-assessment.ts`); `__tests__/pain-assessment-corpus.test.ts` pins the two.
//
// The corpus is DATA with D11-pinned bytes: the choice strings below are interpolated verbatim and are copied, not imported,
// from `@chartwarden/types`, so editing a constant there can never reword a shipped phrase.
//
// The phrases state what the clinician typed or chose and carry no clinical judgement. Lora, RN signed the sheet's section 2c off as a
// whole on 2026-11-25 (not item by item); `CORPUS_CLINICAL_REVIEW` stays `pending` (reviewer ADA) and gates only the per-tenant draft
// switch. Sources for the content: docs/research/PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { SlotSpec, VocabEntry } from "./types";

// The same scoping as the pain statements they hang off (`nv.sym.pain_uncontrolled`); a test pins that they stay equal.
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

export const PAIN_ASSESSMENT_VOCABULARY: readonly VocabEntry[] = [
  // ── the HOPE characteristics (J0910C): the clinician's own words ───────────────────────────────────────────
  statement(
    "nv.sym.pain_location",
    "Pain assessment — location",
    "Pain location: ${pain_location}",
  ),
  statement(
    "nv.sym.pain_character",
    "Pain assessment — character",
    "Pain character: ${pain_character}",
  ),
  statement(
    "nv.sym.pain_duration",
    "Pain assessment — duration",
    "Pain duration: ${pain_duration}",
  ),
  statement(
    "nv.sym.pain_frequency",
    "Pain assessment — frequency",
    "Pain frequency: ${pain_frequency}",
  ),
  statement(
    "nv.sym.pain_worsened_by",
    "Pain assessment — what worsens it",
    "Pain is made worse by ${pain_worsened_by}",
  ),
  statement(
    "nv.sym.pain_relieved_by",
    "Pain assessment — what relieves it",
    "Pain is relieved by ${pain_relieved_by}",
  ),

  // ── response to treatment ──────────────────────────────────────────────────────────────────────────────
  statement(
    "nv.sym.pain_prn_relief",
    "Pain assessment — response to the last as-needed dose",
    "Response to the last as-needed pain medication dose: ${pain_prn_relief}",
    {
      pain_prn_relief: {
        kind: "choice",
        options: ["complete relief", "partial relief", "no relief", "no dose taken"],
        label: "Response to the last as-needed dose",
      },
    },
  ),
  statement(
    "nv.sym.pain_side_effects",
    "Pain assessment — medication side effects",
    "Pain medication side effects: ${pain_side_effects}",
  ),
  statement(
    "nv.sym.pain_bowel_regimen",
    "Pain assessment — bowel regimen with the opioid",
    "Bowel regimen with the opioid: ${bowel_regimen}",
  ),
  statement(
    "nv.sym.pain_oral_barrier",
    "Pain assessment — cannot take oral pain medication",
    "${patient} cannot take oral pain medication: ${oral_barrier}",
  ),

  // ── a patient who cannot self-report ───────────────────────────────────────────────────────────────────
  statement(
    "nv.sym.pain_nonverbal",
    "Pain assessment — cannot self-report, nonverbal cues",
    "${patient} is unable to self-report pain; nonverbal cues observed: ${nonverbal_cues}",
  ),
  statement(
    "nv.sym.pain_observation_scale",
    "Pain assessment — observation scale",
    "${observation_tool} score is ${observation_score} of 10",
    {
      observation_tool: {
        kind: "choice",
        options: ["PAINAD", "FLACC"],
        label: "Observation scale",
      },
      observation_score: score("Observation scale score (0–10)"),
    },
  ),

  // ── the patient's goal and the change since the last visit ─────────────────────────────────────────────
  statement(
    "nv.sym.pain_goal",
    "Pain assessment — the patient's acceptable pain level",
    "${patient}'s stated acceptable pain level is ${pain_goal} of 10",
    { pain_goal: score("Acceptable pain level (0–10)") },
  ),
  statement(
    "nv.sym.pain_last_score",
    "Pain assessment — pain score at the last visit",
    "Pain at the last visit was ${pain_last_score} of 10",
    { pain_last_score: score("Pain score at the last visit (0–10)") },
  ),
  statement(
    "nv.sym.pain_change",
    "Pain assessment — change since the last visit",
    "Change in pain since the last visit: ${pain_change}",
    {
      pain_change: {
        kind: "choice",
        options: ["improved", "unchanged", "worsened", "new pain"],
        label: "Change since the last visit",
      },
    },
  ),

  // ── the clinician's decision about the plan of care ────────────────────────────────────────────────────
  statement(
    "nv.sym.pain_plan_decision",
    "Pain assessment — plan of care decision",
    "Plan of care for pain: ${pain_plan_decision}",
    {
      pain_plan_decision: {
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
