// packages/narrative-vocab/src/draft-entries.ts — the visit-note draft phrases (S1 PR B, ADR-0114, VN-D15).
//
// Appended to the corpus by `vocabulary.ts`: the 25 entries of `narrative-vocab@2026.11.0` below (S1), then the 11 of
// `narrative-vocab@2026.12.0` (S2, `recert-entries.ts`), then the 5 of `narrative-vocab@2026.12.1` (S2b, `admission-entries.ts`); the
// 23 earlier entries are untouched. DRAFT WORDING until the review of the running release is "approved" (see
// `CORPUS_CLINICAL_REVIEW` in vocabulary.ts).
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { ADMISSION_VOCABULARY } from "./admission-entries";
import { RECERT_VOCABULARY } from "./recert-entries";
import type { VocabEntry } from "./types";

const RN_ONLY: readonly EncounterDiscipline[] = ["rn"];
const ROUTINE_ONLY: readonly EncounterType[] = ["routine_visit"];

/** The 25 entries of `narrative-vocab@2026.11.0`, in corpus order (appended after the original 23), tagged as S1 shipped them. */
const ROUTINE_DRAFT_VOCABULARY: readonly VocabEntry[] = [
  // All entries are tagged for the RN routine visit only, so no other template's menu gains an entry.
  // The `scale_reading` and `medication_change` entries are listed in no section menu: they carry values
  // the draft compiler interpolates from structured records, never typed by hand. Wording states numbers
  // and dates only; "down", "up" and "unchanged" restate the arithmetic, not a clinical judgement.

  // ── scale readings (PPS, ESAS-r) with the change since the previous reading ───────────────────────
  {
    code: "nv.scale.pps_first",
    label: "Scale — PPS, no earlier reading",
    phrase: "PPS ${pps_value}%, no earlier reading recorded",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.pps_down",
    label: "Scale — PPS, lower than the previous reading",
    phrase: "PPS ${pps_value}%, down from ${pps_previous_value}% on ${pps_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.pps_up",
    label: "Scale — PPS, higher than the previous reading",
    phrase: "PPS ${pps_value}%, up from ${pps_previous_value}% on ${pps_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.pps_same",
    label: "Scale — PPS, same as the previous reading",
    phrase: "PPS ${pps_value}%, unchanged from ${pps_previous_value}% on ${pps_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.esas_first",
    label: "Scale — ESAS-r, no earlier reading",
    phrase: "ESAS-r ${esas_label} ${esas_value}, no earlier reading recorded",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.esas_down",
    label: "Scale — ESAS-r, lower than the previous reading",
    phrase:
      "ESAS-r ${esas_label} ${esas_value}, down from ${esas_previous_value} on ${esas_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.esas_up",
    label: "Scale — ESAS-r, higher than the previous reading",
    phrase:
      "ESAS-r ${esas_label} ${esas_value}, up from ${esas_previous_value} on ${esas_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.scale.esas_same",
    label: "Scale — ESAS-r, same as the previous reading",
    phrase:
      "ESAS-r ${esas_label} ${esas_value}, unchanged from ${esas_previous_value} on ${esas_previous_date}",
    category: "scale_reading",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },

  // ── vitals (the RN routine visit's `vitals_review` menu) ───────────────────────────────────────────
  {
    code: "nv.vit.reviewed",
    label: "Vitals — reviewed",
    phrase: "Vital signs for this visit were reviewed",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.bp",
    label: "Vitals — blood pressure",
    phrase: "Blood pressure ${bp_systolic}/${bp_diastolic} mmHg",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.hr",
    label: "Vitals — heart rate",
    phrase: "Heart rate ${heart_rate} beats per minute",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.rr",
    label: "Vitals — respiratory rate",
    phrase: "Respiratory rate ${respiratory_rate} breaths per minute",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.temp",
    label: "Vitals — temperature",
    phrase: "Temperature ${temperature} degrees ${temperature_unit}",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.spo2",
    label: "Vitals — oxygen saturation",
    phrase: "Oxygen saturation ${spo2}%",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.vit.pain",
    label: "Vitals — pain score",
    phrase: "Pain score ${pain_score} of 10",
    category: "vitals_review",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },

  // ── care-plan goals and interventions linked to the visit ──────────────────────────────────────────
  {
    code: "nv.cp.goal_progress",
    label: "Care plan — goal with progress statement",
    phrase: "Care-plan goal: ${goal_text}; progress: ${progress_statement}",
    category: "care_plan_element",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.cp.goal_listed",
    label: "Care plan — goal",
    phrase: "Care-plan goal: ${goal_text}",
    category: "care_plan_element",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.cp.intervention_performed",
    label: "Care plan — intervention performed",
    phrase: "Care-plan intervention performed: ${intervention_text}",
    category: "care_plan_element",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },

  // ── medication and order changes since the last visit ──────────────────────────────────────────────
  {
    code: "nv.med.started",
    label: "Medication — started",
    phrase: "${drug_name} was started on ${change_date}",
    category: "medication_change",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.med.changed",
    label: "Medication — order changed",
    phrase: "${drug_name} order was changed on ${change_date}",
    category: "medication_change",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.med.discontinued",
    label: "Medication — discontinued",
    phrase: "${drug_name} was discontinued on ${change_date}",
    category: "medication_change",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },

  // ── RN routine visit: chief concern and plan menus ─────────────────────────────────────────────────
  {
    code: "nv.cc.routine_visit",
    label: "Reason for visit — routine scheduled visit",
    phrase: "Routine scheduled visit per the plan of care",
    category: "chief_concern",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.cc.follow_up",
    label: "Reason for visit — follow-up",
    phrase: "Visit to follow up on ${follow_up_topic}",
    category: "chief_concern",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.plan.continue",
    label: "Plan — current plan of care continues",
    phrase: "The current plan of care continues",
    category: "plan",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
  {
    code: "nv.plan.next_visit",
    label: "Plan — next visit date",
    phrase: "Next visit is planned for ${next_visit_date}",
    category: "plan",
    disciplines: RN_ONLY,
    encounterTypes: ROUTINE_ONLY,
  },
] as const;

/**
 * The S1 entries the recertification visit also drafts from (S2, design §3.3): its vitals, care-plan, medication and PPS/ESAS-r
 * phrases. Their wording is untouched (a test pins the text of all 25); `narrative-vocab@2026.12.0` only adds the
 * `recert_visit` tag, which is what lets that template draft them. `nv.vit.reviewed`, `nv.cc.*` and `nv.plan.*` are the routine
 * visit's own hand-picked phrases and stay routine-only.
 */
const RECERT_SHARED_CODES: ReadonlySet<string> = new Set([
  "nv.scale.pps_first",
  "nv.scale.pps_down",
  "nv.scale.pps_up",
  "nv.scale.pps_same",
  "nv.scale.esas_first",
  "nv.scale.esas_down",
  "nv.scale.esas_up",
  "nv.scale.esas_same",
  "nv.vit.bp",
  "nv.vit.hr",
  "nv.vit.rr",
  "nv.vit.temp",
  "nv.vit.spo2",
  "nv.vit.pain",
  "nv.cp.goal_progress",
  "nv.cp.goal_listed",
  "nv.cp.intervention_performed",
  "nv.med.started",
  "nv.med.changed",
  "nv.med.discontinued",
]);

const ROUTINE_AND_RECERT: readonly EncounterType[] = ["routine_visit", "recert_visit"];

/**
 * Of those, the ones the RN admission visit also drafts from (S2b, VN-D38): its vitals, care-plan, medication-change and ESAS-r phrases
 * (the PPS phrases are not: `assessment` is not drafted at admission). Same rule as above: wording untouched, only the
 * `admission_visit` tag added by `narrative-vocab@2026.12.1`.
 */
const ADMISSION_SHARED_CODES: ReadonlySet<string> = new Set(
  [...RECERT_SHARED_CODES].filter((code) => !code.startsWith("nv.scale.pps_")),
);

const ROUTINE_RECERT_AND_ADMISSION: readonly EncounterType[] = [
  "routine_visit",
  "recert_visit",
  "admission_visit",
];

const encounterTypesOf = (code: string): readonly EncounterType[] | undefined =>
  ADMISSION_SHARED_CODES.has(code)
    ? ROUTINE_RECERT_AND_ADMISSION
    : RECERT_SHARED_CODES.has(code)
      ? ROUTINE_AND_RECERT
      : undefined;

/**
 * Every draft entry, in corpus order: the 25 of 2026.11.0 (the shared ones also tagged for the recertification, and the admission
 * visit's), then the 11 of 2026.12.0, then the 5 of 2026.12.1.
 */
export const DRAFT_VOCABULARY: readonly VocabEntry[] = [
  ...ROUTINE_DRAFT_VOCABULARY.map((entry): VocabEntry => {
    const encounterTypes = encounterTypesOf(entry.code);
    return encounterTypes === undefined ? entry : { ...entry, encounterTypes };
  }),
  ...RECERT_VOCABULARY,
  ...ADMISSION_VOCABULARY,
];

/**
 * The codes of the draft entries: the phrases a tenant's authoring menu offers only once that tenant's visit-note draft switch is on,
 * so a tenant with the switch off sees the corpus as it was before `narrative-vocab@2026.11.0` (design §3.2 "Rollout").
 */
export const DRAFT_VOCAB_CODES: ReadonlySet<string> = new Set(DRAFT_VOCABULARY.map((e) => e.code));
