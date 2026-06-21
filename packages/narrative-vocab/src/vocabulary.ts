// packages/narrative-vocab/src/vocabulary.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The curated Phase-1 vocabulary corpus. This is DATA, not logic: a bounded set of discipline- and
// encounter-type-scoped phrase templates spanning the nine body systems, HOPE-aligned symptom impact,
// care-plan elements, psychosocial, spiritual, ADL, and the boilerplate attestation lines. Vocabulary
// content is semver-released through this leaf package (`VOCAB_VERSION`); a draft's selected version is
// pinned at first finalize (D11) and the assembly engine asserts the selection was authored against the
// version it resolves. Expanding the corpus is additive and never edits a shipped phrase's bytes (Layer-1
// determinism depends on phrase stability).
import type { EncounterDiscipline, EncounterType } from "@wardenx/types";
import type { VocabEntry } from "./types";

/** Semantic version of the shipped corpus; pinned onto a selection at first finalize (D11). */
export const VOCAB_VERSION = "narrative-vocab@2026.06.0";

// ── scoping shorthands (kept local so each entry's tags read 1:1 with the encounter model) ───────────
const NURSING: readonly EncounterDiscipline[] = ["rn", "lpn"];
const PROVIDERS: readonly EncounterDiscipline[] = ["md", "np"];
const SKILLED: readonly EncounterDiscipline[] = ["rn", "lpn", "md", "np"];

const NURSING_TYPES: readonly EncounterType[] = [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "lpn_visit",
  "telephonic",
];
const PROVIDER_TYPES: readonly EncounterType[] = ["face_to_face", "telephonic"];
const CLINICAL_TYPES: readonly EncounterType[] = [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "face_to_face",
  "lpn_visit",
];

/** The curated corpus (ordering is stable and load-bearing for byte-identical assembly). */
export const VOCABULARY: readonly VocabEntry[] = [
  // ── per-body-system observations ───────────────────────────────────────────────────────────────
  {
    code: "nv.cv.stable",
    label: "Cardiovascular — stable, no acute distress",
    phrase: "${patient} is cardiovascularly stable with no chest pain or palpitations reported",
    category: "observation",
    bodySystem: "cardiovascular",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.cv.edema",
    label: "Cardiovascular — dependent edema present",
    phrase: "${patient} has ${edema_grade} dependent edema in the bilateral lower extremities",
    category: "observation",
    bodySystem: "cardiovascular",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.resp.unlabored",
    label: "Respiratory — unlabored, lungs clear",
    phrase: "${patient}'s respirations are unlabored and lung sounds are clear to auscultation",
    category: "observation",
    bodySystem: "respiratory",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.resp.dyspnea",
    label: "Respiratory — dyspnea on exertion",
    phrase: "${patient} reports dyspnea on exertion and uses oxygen at ${o2_lpm} L/min via nasal cannula",
    category: "observation",
    bodySystem: "respiratory",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.neuro.alert",
    label: "Neurological — alert and oriented",
    phrase: "${patient} is alert and oriented to person, place, and time",
    category: "observation",
    bodySystem: "neurological",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.neuro.decline",
    label: "Neurological — increased somnolence",
    phrase: "${patient} demonstrates increased somnolence and is oriented to person only",
    category: "observation",
    bodySystem: "neurological",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.gi.intact",
    label: "Gastrointestinal — appetite adequate, no distress",
    phrase: "${patient} reports an adequate appetite with no nausea, and the last bowel movement was ${last_bm}",
    category: "observation",
    bodySystem: "gastrointestinal",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.gu.continent",
    label: "Genitourinary — continent, no retention",
    phrase: "${patient} is continent of urine with no signs of retention or dysuria",
    category: "observation",
    bodySystem: "genitourinary",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.integ.intact",
    label: "Integumentary — skin intact",
    phrase: "${patient}'s skin is intact, warm, and dry with no open areas noted",
    category: "observation",
    bodySystem: "integumentary",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.integ.wound",
    label: "Integumentary — pressure injury present",
    phrase: "${patient} has a stage ${wound_stage} pressure injury at the ${wound_site}, dressed per orders",
    category: "observation",
    bodySystem: "integumentary",
    disciplines: NURSING,
    encounterTypes: NURSING_TYPES,
  },
  {
    code: "nv.msk.limited",
    label: "Musculoskeletal — limited mobility",
    phrase: "${patient} has limited mobility and requires ${assist_level} assistance with transfers",
    category: "observation",
    bodySystem: "musculoskeletal",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },

  // ── HOPE J2051-aligned symptom impact ──────────────────────────────────────────────────────────
  {
    code: "nv.sym.pain_controlled",
    label: "Symptom impact — pain controlled on current regimen",
    phrase: "${patient}'s pain is well controlled at ${pain_score} of 10 on the current medication regimen",
    category: "symptom_impact",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.sym.pain_uncontrolled",
    label: "Symptom impact — pain limiting function",
    phrase: "${patient} reports pain at ${pain_score} of 10 that limits participation in daily activities",
    category: "symptom_impact",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.sym.dyspnea_impact",
    label: "Symptom impact — dyspnea limiting function",
    phrase: "Dyspnea limits ${patient}'s ability to ambulate beyond ${ambulation_distance}",
    category: "symptom_impact",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },

  // ── care-plan elements ─────────────────────────────────────────────────────────────────────────
  {
    code: "nv.cp.medrec",
    label: "Care plan — medication reconciliation reviewed",
    phrase: "The medication regimen was reconciled with the caregiver and reviewed against the care plan",
    category: "care_plan_element",
    disciplines: SKILLED,
    encounterTypes: ["admission_visit", "routine_visit", "recert_visit", "face_to_face"],
  },
  {
    code: "nv.cp.caregiver_taught",
    label: "Care plan — caregiver education provided",
    phrase: "Caregiver education was provided on ${teaching_topic} with return demonstration verbalized",
    category: "care_plan_element",
    disciplines: NURSING,
    encounterTypes: NURSING_TYPES,
  },
  {
    code: "nv.cp.goals_progress",
    label: "Care plan — progress toward goals",
    phrase: "Progress toward the care-plan goals was reviewed and ${patient} remains appropriate for hospice",
    category: "care_plan_element",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },

  // ── psychosocial (MSW) ─────────────────────────────────────────────────────────────────────────
  {
    code: "nv.ps.coping",
    label: "Psychosocial — coping assessment",
    phrase: "${patient} and family are coping with the prognosis with ${coping_status} support systems in place",
    category: "psychosocial",
    disciplines: ["msw"],
    encounterTypes: ["msw_assessment", "msw_followup", "telephonic", "idg_followup"],
  },
  {
    code: "nv.ps.family_dynamics",
    label: "Psychosocial — family dynamics",
    phrase: "Family dynamics were assessed; ${family_dynamics_note}",
    category: "psychosocial",
    disciplines: ["msw"],
    encounterTypes: ["msw_assessment", "msw_followup"],
  },

  // ── spiritual (Chaplain) ───────────────────────────────────────────────────────────────────────
  {
    code: "nv.sp.assessment",
    label: "Spiritual — spiritual care assessment",
    phrase: "A spiritual care assessment was completed and ${patient} identifies as ${faith_tradition}",
    category: "spiritual",
    disciplines: ["chaplain"],
    encounterTypes: ["chaplain_assessment", "chaplain_visit", "idg_followup"],
  },
  {
    code: "nv.sp.support",
    label: "Spiritual — supportive presence provided",
    phrase: "Supportive presence and ${spiritual_intervention} were provided at the bedside",
    category: "spiritual",
    disciplines: ["chaplain"],
    encounterTypes: ["chaplain_assessment", "chaplain_visit", "bereavement_contact"],
  },

  // ── ADL (CHHA) ─────────────────────────────────────────────────────────────────────────────────
  {
    code: "nv.adl.personal_care",
    label: "ADL — personal care provided",
    phrase: "Personal care was provided including ${adl_tasks} per the aide plan of care",
    category: "adl",
    disciplines: ["chha"],
    encounterTypes: ["chha_visit"],
  },

  // ── attestation (boilerplate; kept verbatim, never paraphrased) ────────────────────────────────
  {
    code: "nv.att.f2f",
    label: "Attestation — face-to-face encounter",
    phrase:
      "I attest that I had a face-to-face encounter with the patient and that the clinical findings support a continued prognosis of six months or less if the terminal illness runs its normal course",
    category: "attestation",
    disciplines: PROVIDERS,
    encounterTypes: ["face_to_face"],
  },
] as const;
