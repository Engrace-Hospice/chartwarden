// packages/narrative-vocab/src/vocabulary.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The curated Phase-1 vocabulary corpus. This is DATA, not logic: a bounded set of discipline- and
// encounter-type-scoped phrase templates spanning the nine body systems, HOPE-aligned symptom impact,
// care-plan elements, psychosocial, spiritual, ADL, and the boilerplate attestation lines. Vocabulary
// content is semver-released through this leaf package (`VOCAB_VERSION`); a draft's selected version is
// pinned at first finalize (D11) and the assembly engine asserts the selection was authored against the
// version it resolves. Expanding the corpus is additive and never edits a shipped phrase's bytes (Layer-1
// determinism depends on phrase stability).
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { DRAFT_VOCABULARY } from "./draft-entries";
import type { SlotSpec, VocabEntry } from "./types";

/**
 * Slot constraints. They bound what a clinician may type, never the phrase bytes (D11 — see `SlotSpec`).
 * Each `choice` option must read correctly inside its phrase: "requires moderate assistance with
 * transfers", "has 2+ dependent edema", "limits ability to ambulate beyond 25 feet".
 */
const PAIN_SCORE: SlotSpec = { kind: "integer", min: 0, max: 10, label: "Pain score (0–10)" };
const EDEMA_GRADE: SlotSpec = {
  kind: "choice",
  options: ["trace", "1+", "2+", "3+", "4+"],
  label: "Edema grade",
};
// ponytail: the phrase says "via nasal cannula", whose practical ceiling is 6 L/min. Widen if a mask or
// high-flow phrase is ever added, as its own entry.
const O2_FLOW: SlotSpec = {
  kind: "number",
  min: 0.5,
  max: 6,
  unit: "L/min",
  label: "Oxygen flow",
};
const ASSIST_LEVEL: SlotSpec = {
  kind: "choice",
  options: ["minimal", "moderate", "maximal", "total"],
  label: "Assistance needed",
};
const WALK_DISTANCE: SlotSpec = {
  kind: "choice",
  options: ["5 feet", "10 feet", "25 feet", "50 feet", "100 feet"],
  label: "Walking distance",
};
const WOUND_STAGE: SlotSpec = {
  kind: "choice",
  options: ["1", "2", "3", "4"],
  label: "Pressure injury stage",
};

/** The reason a visit follows up a recorded fall: the one reason a fall can be linked to. */
export const FALL_FOLLOWUP_CODE = "nv.reason.fall_followup";

/**
 * Semantic version of the shipped corpus; pinned onto a selection at first finalize (D11).
 * 2026.11.0 added the visit-note draft phrases (ADR-0114); 2026.11.1 added the `visit_reason` entries; 2026.12.0 added the recertification
 * and face-to-face draft phrases (ADR-0114 S2); 2026.12.1 adds the RN admission visit's draft phrases (ADR-0114 S2b); 2026.12.2 tags existing draft phrases for
 * the LPN visits and the aide visit (ADR-0114 S3), no new wording; 2026.12.3 adds the social-work and chaplain plan phrases (ADR-0114 S4);
 * 2026.12.4 tags existing draft phrases for the face-to-face visit's vitals and orders and for the IDG follow-up (ADR-0114 S5), no new wording;
 * 2026.12.5 adds the two IDG follow-up phrases and the ten decision-kind labels (ADR-0114 S5b).
 */
export const VOCAB_VERSION = "narrative-vocab@2026.12.5";

/** Whether the named clinical reviewer has approved the corpus wording. */
export type ClinicalReviewStatus = "pending" | "approved";

/**
 * CLINICAL REVIEW GATE (VN-D14, ADR-0114). Every phrase added in `narrative-vocab@2026.11.0` (the 25
 * visit-note draft entries after the original 23: scale readings, vitals, care-plan goals and
 * interventions, medication changes, and the RN routine visit's chief-concern and plan phrases) and in
 * `narrative-vocab@2026.12.0` (the 11 recertification and face-to-face entries: PPS and weight against
 * the benefit period, the face-to-face's facts, the benefit period) and in `narrative-vocab@2026.12.1` (the 5 admission entries: the
 * orders in effect, the caregivers on record, the advance directive acknowledgment on file) is DRAFT WORDING. It was written to be neutral and factual (numbers and dates, no clinical judgement), but
 * it has not been read by a clinician. The platform-side reviewer named by the owner on 2026-11-18 is ADA.
 *
 * `status` stays "pending" until ADA approves the wording; the approval is a deliberate edit to this
 * constant in its own commit. A later PR (the per-tenant switch, VN-D17) REFUSES to enable the draft for
 * any tenant while the review is not approved FOR THE RUNNING RELEASE (`effectiveReviewStatus`).
 *
 * An approval is of one release (S2 design): `reviewedVersion` names the `VOCAB_VERSION` ADA read. A release cut
 * after the approval carries wording nobody has read, so the approval stops counting for it, and the corpus test
 * fails until the commit that bumped `VOCAB_VERSION` settles the review (ADA approves the new release, or this goes
 * back to "pending"). Going back to "pending" refuses new enables only; it does not switch off a tenant already on.
 */
export const CORPUS_CLINICAL_REVIEW: {
  readonly reviewer: "ADA";
  readonly status: ClinicalReviewStatus;
  /** The corpus release the approval covers; `null` while the review is pending. */
  readonly reviewedVersion: string | null;
} = { reviewer: "ADA", status: "pending", reviewedVersion: null };

/** A review state as the switch gate reads it (what `CORPUS_CLINICAL_REVIEW` carries; a test injects another). */
export interface CorpusReviewState {
  readonly reviewer: string;
  readonly status: ClinicalReviewStatus;
  readonly reviewedVersion: string | null;
}

/**
 * The review state that counts for `version` (default: the running release). "approved" only when the review is
 * approved AND names exactly that release; a pending review, or an approval that names no release or another one,
 * is "pending". Fails closed.
 */
export function effectiveReviewStatus(
  review: CorpusReviewState,
  version: string = VOCAB_VERSION,
): ClinicalReviewStatus {
  return review.status === "approved" && review.reviewedVersion === version
    ? "approved"
    : "pending";
}

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

/** Visits a reason for visit is chosen on: what nurses and providers document, plus their phone visits. */
const REASON_TYPES: readonly EncounterType[] = [...CLINICAL_TYPES, "telephonic"];

/** Every visit type except the two that are not a clinician's own visit (a bereavement contact, an IDG follow-up). */
const ALL_VISIT_TYPES: readonly EncounterType[] = [
  ...REASON_TYPES,
  "chha_visit",
  "msw_assessment",
  "msw_followup",
  "chaplain_assessment",
  "chaplain_visit",
  "volunteer_visit",
  "pt_visit",
  "ot_visit",
  "slp_visit",
];
const ALL_DISCIPLINES: readonly EncounterDiscipline[] = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
  "pt",
  "ot",
  "slp",
];
const THERAPY: readonly EncounterDiscipline[] = ["pt", "ot", "slp"];
const THERAPY_TYPES: readonly EncounterType[] = ["pt_visit", "ot_visit", "slp_visit"];
const SOCIAL_WORK_TYPES: readonly EncounterType[] = [
  "msw_assessment",
  "msw_followup",
  "telephonic",
];
const CHAPLAIN_TYPES: readonly EncounterType[] = [
  "chaplain_assessment",
  "chaplain_visit",
  "telephonic",
];

/**
 * One "Reason for Visit" choice. All share a group, so a note carries exactly one primary reason. A reason
 * is offered to nurses and providers on their visits unless it says otherwise.
 */
function reason(
  code: string,
  label: string,
  phrase: string,
  scope: {
    readonly disciplines?: readonly EncounterDiscipline[];
    readonly encounterTypes?: readonly EncounterType[];
  } = {},
): VocabEntry {
  return {
    code,
    label,
    phrase,
    category: "visit_reason",
    exclusiveGroup: "visit-reason",
    disciplines: scope.disciplines ?? SKILLED,
    encounterTypes: scope.encounterTypes ?? REASON_TYPES,
  };
}

/** The 23 entries shipped in narrative-vocab@2026.06.0 (phrase bytes never edited; ordering is load-bearing). */
const CORE_VOCABULARY: readonly VocabEntry[] = [
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
    slotSpecs: { edema_grade: EDEMA_GRADE },
    label: "Cardiovascular — dependent edema present",
    phrase: "${patient} has ${edema_grade} dependent edema in the bilateral lower extremities",
    category: "observation",
    bodySystem: "cardiovascular",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.resp.unlabored",
    exclusiveGroup: "respiratory-status",
    label: "Respiratory — unlabored, lungs clear",
    phrase: "${patient}'s respirations are unlabored and lung sounds are clear to auscultation",
    category: "observation",
    bodySystem: "respiratory",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.resp.dyspnea",
    exclusiveGroup: "respiratory-status",
    slotSpecs: { o2_lpm: O2_FLOW },
    label: "Respiratory — dyspnea on exertion",
    phrase:
      "${patient} reports dyspnea on exertion and uses oxygen at ${o2_lpm} L/min via nasal cannula",
    category: "observation",
    bodySystem: "respiratory",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.neuro.alert",
    exclusiveGroup: "neurological-status",
    label: "Neurological — alert and oriented",
    phrase: "${patient} is alert and oriented to person, place, and time",
    category: "observation",
    bodySystem: "neurological",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.neuro.decline",
    exclusiveGroup: "neurological-status",
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
    phrase:
      "${patient} reports an adequate appetite with no nausea, and the last bowel movement was ${last_bm}",
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
    exclusiveGroup: "skin-status",
    label: "Integumentary — skin intact",
    phrase: "${patient}'s skin is intact, warm, and dry with no open areas noted",
    category: "observation",
    bodySystem: "integumentary",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.integ.wound",
    exclusiveGroup: "skin-status",
    slotSpecs: { wound_stage: WOUND_STAGE },
    label: "Integumentary — pressure injury present",
    phrase:
      "${patient} has a stage ${wound_stage} pressure injury at the ${wound_site}, dressed per orders",
    category: "observation",
    bodySystem: "integumentary",
    disciplines: NURSING,
    encounterTypes: NURSING_TYPES,
  },
  {
    code: "nv.msk.limited",
    slotSpecs: { assist_level: ASSIST_LEVEL },
    label: "Musculoskeletal — limited mobility",
    phrase:
      "${patient} has limited mobility and requires ${assist_level} assistance with transfers",
    category: "observation",
    bodySystem: "musculoskeletal",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },

  // ── HOPE J2051-aligned symptom impact ──────────────────────────────────────────────────────────
  {
    code: "nv.sym.pain_controlled",
    exclusiveGroup: "pain-status",
    slotSpecs: { pain_score: PAIN_SCORE },
    label: "Symptom impact — pain controlled on current regimen",
    phrase:
      "${patient}'s pain is well controlled at ${pain_score} of 10 on the current medication regimen",
    category: "symptom_impact",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.sym.pain_uncontrolled",
    exclusiveGroup: "pain-status",
    slotSpecs: { pain_score: PAIN_SCORE },
    label: "Symptom impact — pain limiting function",
    phrase:
      "${patient} reports pain at ${pain_score} of 10 that limits participation in daily activities",
    category: "symptom_impact",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },
  {
    code: "nv.sym.dyspnea_impact",
    slotSpecs: { ambulation_distance: WALK_DISTANCE },
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
    phrase:
      "The medication regimen was reconciled with the caregiver and reviewed against the care plan",
    category: "care_plan_element",
    disciplines: SKILLED,
    encounterTypes: ["admission_visit", "routine_visit", "recert_visit", "face_to_face"],
  },
  {
    code: "nv.cp.caregiver_taught",
    label: "Care plan — caregiver education provided",
    phrase:
      "Caregiver education was provided on ${teaching_topic} with return demonstration verbalized",
    category: "care_plan_element",
    disciplines: NURSING,
    encounterTypes: NURSING_TYPES,
  },
  {
    code: "nv.cp.goals_progress",
    label: "Care plan — progress toward goals",
    phrase:
      "Progress toward the care-plan goals was reviewed and ${patient} remains appropriate for hospice",
    category: "care_plan_element",
    disciplines: SKILLED,
    encounterTypes: CLINICAL_TYPES,
  },

  // ── psychosocial (MSW) ─────────────────────────────────────────────────────────────────────────
  {
    code: "nv.ps.coping",
    label: "Psychosocial — coping assessment",
    phrase:
      "${patient} and family are coping with the prognosis with ${coping_status} support systems in place",
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
    phrase:
      "A spiritual care assessment was completed and ${patient} identifies as ${faith_tradition}",
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

/** The `visit_reason` entries added in narrative-vocab@2026.11.1 (appended after the draft entries; never edited). */
const VISIT_REASON_VOCABULARY: readonly VocabEntry[] = [
  // ── visit reasons (2026.11.1) — the "Reason for Visit" choice; one per note, details go in free text ─
  reason(
    "nv.reason.routine",
    "Routine scheduled visit",
    "this is a routine scheduled visit per the plan of care",
    { disciplines: ALL_DISCIPLINES, encounterTypes: ALL_VISIT_TYPES },
  ),
  reason(
    FALL_FOLLOWUP_CODE,
    "Follow-up after a fall",
    "this visit is a follow-up after a recent fall",
    {
      disciplines: [...SKILLED, "pt", "ot"],
      encounterTypes: [...REASON_TYPES, "pt_visit", "ot_visit"],
    },
  ),
  reason(
    "nv.reason.pain",
    "Pain assessment and management",
    "this visit is for pain assessment and management",
  ),
  reason(
    "nv.reason.symptom_change",
    "New or changing symptom",
    "this visit is for a new or changing symptom",
  ),
  reason(
    "nv.reason.condition_change",
    "Decline or change in condition",
    "this visit is for a decline or change in condition",
    {
      disciplines: [...SKILLED, "msw", "chaplain", ...THERAPY],
      encounterTypes: [...REASON_TYPES, ...SOCIAL_WORK_TYPES, ...CHAPLAIN_TYPES, ...THERAPY_TYPES],
    },
  ),
  reason(
    "nv.reason.medication",
    "Medication review or change",
    "this visit is for medication review or a medication change",
  ),
  reason("nv.reason.wound", "Wound or skin care", "this visit is for wound or skin care"),
  reason(
    "nv.reason.post_hospital",
    "Follow-up after ER visit or hospital stay",
    "this visit follows an emergency department visit or hospital stay",
    {
      disciplines: [...SKILLED, "msw"],
      encounterTypes: [...REASON_TYPES, ...SOCIAL_WORK_TYPES],
    },
  ),
  reason(
    "nv.reason.caregiver",
    "Caregiver concern",
    "this visit is to address a caregiver concern",
    {
      disciplines: ALL_DISCIPLINES.filter((d) => d !== "volunteer"),
      encounterTypes: ALL_VISIT_TYPES.filter((t) => t !== "volunteer_visit"),
    },
  ),
  reason(
    "nv.reason.family_request",
    "Patient or family request",
    "this visit was requested by the patient or family",
    { disciplines: ALL_DISCIPLINES, encounterTypes: ALL_VISIT_TYPES },
  ),

  // ── visit reasons for the other disciplines (2026.11.1) ────────────────────────────────────────────
  reason("nv.reason.personal_care", "Personal care", "this visit is for personal care", {
    disciplines: ["chha"],
    encounterTypes: ["chha_visit"],
  }),
  reason("nv.reason.respite", "Caregiver respite", "this visit is to give the caregiver a break", {
    disciplines: ["chha", "volunteer"],
    encounterTypes: ["chha_visit", "volunteer_visit"],
  }),
  reason(
    "nv.reason.psychosocial",
    "Psychosocial assessment",
    "this visit is for a psychosocial assessment",
    { disciplines: ["msw"], encounterTypes: SOCIAL_WORK_TYPES },
  ),
  reason(
    "nv.reason.advance_care_planning",
    "Advance care planning",
    "this visit is for advance care planning",
    { disciplines: ["msw"], encounterTypes: SOCIAL_WORK_TYPES },
  ),
  reason(
    "nv.reason.resources",
    "Financial or resource need",
    "this visit is to address a financial or resource need",
    { disciplines: ["msw"], encounterTypes: SOCIAL_WORK_TYPES },
  ),
  reason(
    "nv.reason.grief",
    "Anticipatory grief support",
    "this visit is for anticipatory grief support",
    {
      disciplines: ["msw", "chaplain"],
      encounterTypes: [...SOCIAL_WORK_TYPES, ...CHAPLAIN_TYPES],
    },
  ),
  reason("nv.reason.crisis", "Crisis intervention", "this visit is for crisis intervention", {
    disciplines: ["msw", "chaplain"],
    encounterTypes: [...SOCIAL_WORK_TYPES, ...CHAPLAIN_TYPES],
  }),
  reason(
    "nv.reason.spiritual_assessment",
    "Spiritual assessment",
    "this visit is for a spiritual assessment",
    { disciplines: ["chaplain"], encounterTypes: CHAPLAIN_TYPES },
  ),
  reason(
    "nv.reason.spiritual_support",
    "Spiritual support",
    "this visit is for spiritual support",
    { disciplines: ["chaplain"], encounterTypes: CHAPLAIN_TYPES },
  ),
  reason(
    "nv.reason.ritual",
    "Ritual or sacrament",
    "this visit is for a requested ritual or sacrament",
    { disciplines: ["chaplain"], encounterTypes: CHAPLAIN_TYPES },
  ),
  reason("nv.reason.companionship", "Companionship", "this visit is for companionship", {
    disciplines: ["volunteer"],
    encounterTypes: ["volunteer_visit"],
  }),
  reason("nv.reason.practical_help", "Practical help", "this visit is to provide practical help", {
    disciplines: ["volunteer"],
    encounterTypes: ["volunteer_visit"],
  }),
  reason("nv.reason.vigil", "Bedside vigil", "this visit is for a bedside vigil", {
    disciplines: ["volunteer"],
    encounterTypes: ["volunteer_visit"],
  }),
  reason(
    "nv.reason.therapy_evaluation",
    "Therapy evaluation",
    "this visit is for a therapy evaluation",
    { disciplines: THERAPY, encounterTypes: THERAPY_TYPES },
  ),
  reason(
    "nv.reason.function_change",
    "Change in mobility or function",
    "this visit is for a change in mobility or function",
    { disciplines: THERAPY, encounterTypes: THERAPY_TYPES },
  ),
  reason(
    "nv.reason.home_safety",
    "Home safety assessment",
    "this visit is for a home safety assessment",
    { disciplines: ["pt", "ot"], encounterTypes: ["pt_visit", "ot_visit"] },
  ),
  reason(
    "nv.reason.caregiver_training",
    "Caregiver training",
    "this visit is for caregiver training",
    {
      disciplines: THERAPY,
      encounterTypes: THERAPY_TYPES,
    },
  ),
  reason(
    "nv.reason.swallowing",
    "Swallowing assessment",
    "this visit is for a swallowing assessment",
    { disciplines: ["slp"], encounterTypes: ["slp_visit"] },
  ),
  reason(
    "nv.reason.communication",
    "Communication assessment",
    "this visit is for a communication assessment",
    { disciplines: ["slp"], encounterTypes: ["slp_visit"] },
  ),
] as const;

/**
 * The curated corpus: the 23 core entries, then the 2026.11.0 draft entries, then the 2026.11.1 visit
 * reasons. Each release only appends (ordering is stable and load-bearing for byte-identical assembly).
 */
export const VOCABULARY: readonly VocabEntry[] = [
  ...CORE_VOCABULARY,
  ...DRAFT_VOCABULARY,
  ...VISIT_REASON_VOCABULARY,
];
