// @chartwarden/inpatient — M37-T05, §2.4/§3.4. The GIP admission-criteria discriminated-union TypeBox (CoP
// 418.108's three permitted GIP criteria) that validates the structured `gip_admission_criteria.data`
// payload, plus the IV-safety overlay invariant schema. Pure schema definitions; validation helpers live
// in ./validate.ts. The route DTOs (M37-T11) reuse `GipCriteriaPayload` verbatim.
import { type Static, Type } from "@sinclair/typebox";

/** GIP criterion 1 — acute symptom management not manageable at home. */
export const GipCriteriaAcuteSymptomManagement = Type.Object({
  criterion_kind: Type.Literal("acute_symptom_management"),
  uncontrolled_symptoms: Type.Array(
    Type.Object({
      symptom: Type.String({ minLength: 3, maxLength: 200 }),
      severity_score: Type.Integer({ minimum: 1, maximum: 10 }),
      duration_hours: Type.Number({ minimum: 0 }),
      interventions_attempted_in_home: Type.Array(Type.String({ minLength: 5, maxLength: 500 })),
    }),
    { minItems: 1 },
  ),
  planned_inpatient_interventions: Type.Array(Type.String({ minLength: 5, maxLength: 500 }), {
    minItems: 1,
  }),
  rationale: Type.String({ minLength: 100, maxLength: 4000 }),
});

/** GIP criterion 2 — terminal care of an imminently dying patient. */
export const GipCriteriaImminentDeath = Type.Object({
  criterion_kind: Type.Literal("imminent_death_terminal_care"),
  clinical_estimate_days_to_death: Type.Integer({ minimum: 0, maximum: 14 }),
  signs_of_imminent_death: Type.Array(
    Type.Union([
      Type.Literal("terminal_secretions"),
      Type.Literal("cheyne_stokes_breathing"),
      Type.Literal("apneic_episodes"),
      Type.Literal("mottling"),
      Type.Literal("cold_extremities"),
      Type.Literal("unresponsiveness"),
      Type.Literal("hypotension_terminal"),
      Type.Literal("terminal_agitation"),
      Type.Literal("other_documented"),
    ]),
    { minItems: 1 },
  ),
  rationale_for_inpatient_setting: Type.String({ minLength: 100, maxLength: 4000 }),
  home_environment_assessment_text: Type.String({ minLength: 50, maxLength: 2000 }),
});

/** GIP criterion 3 — medications/treatments requiring an inpatient setting. */
export const GipCriteriaMedicationsTreatments = Type.Object({
  criterion_kind: Type.Literal("medications_treatments_inpatient_only"),
  named_medications: Type.Array(
    Type.Object({
      rx_norm_code: Type.String({ minLength: 1 }), // M38-validated
      display_name: Type.String({ minLength: 1, maxLength: 200 }),
      why_inpatient_only_text: Type.String({ minLength: 50, maxLength: 1000 }),
    }),
  ),
  named_treatments: Type.Array(
    Type.Object({
      treatment_code: Type.String({ minLength: 1 }), // M38 ipu_treatment_v1
      why_inpatient_only_text: Type.String({ minLength: 50, maxLength: 1000 }),
    }),
  ),
  rationale: Type.String({ minLength: 100, maxLength: 4000 }),
});

/** The §2.4 discriminated union — `gip_admission_criteria.data` must match exactly one arm by `criterion_kind`. */
export const GipCriteriaPayload = Type.Union([
  GipCriteriaAcuteSymptomManagement,
  GipCriteriaImminentDeath,
  GipCriteriaMedicationsTreatments,
]);
export type GipCriteriaPayloadType = Static<typeof GipCriteriaPayload>;

/** §2.6/§3.4 — the IV-safety overlay invariant shape (server-side enforcement; mirrors the ipu_iv_safety_overlay row). */
export const IvSafetyOverlaySpec = Type.Object({
  titration_min_rate: Type.Number({ minimum: 0 }),
  titration_max_rate: Type.Number({ minimum: 0 }),
  rate_unit: Type.Union([
    Type.Literal("mg_per_hour"),
    Type.Literal("mcg_per_kg_per_min"),
    Type.Literal("units_per_hour"),
    Type.Literal("ml_per_hour"),
  ]),
  dual_witness_required: Type.Boolean(),
  max_continuous_duration_hours: Type.Integer({ minimum: 1, maximum: 720 }),
  bedside_check_interval_minutes: Type.Integer({ minimum: 5, maximum: 240 }),
  is_sedation_class: Type.Boolean(),
});
export type IvSafetyOverlaySpecType = Static<typeof IvSafetyOverlaySpec>;

/** The M37 IV infusion rate unit (mirrors IvSafetyOverlaySpec.rate_unit). */
export type IvRateUnit = IvSafetyOverlaySpecType["rate_unit"];
