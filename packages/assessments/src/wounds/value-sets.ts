// @chartwarden/assessments — wound value sets (M9 longitudinal wounds, ADR for WF09).
//
// The stored values of `wound` / `wound_observation`. The clinical sets below (etiology, stage, bed, exudate, odor,
// periwound, dressing, trend) are the contract the visit note (M8 / @chartwarden/hearthnote `RecordedWound`) states
// back, copied here because M9 may not import M8 or its note package (manifest `dependsOn`, architecture §11). A parity
// test (apps/backend/__tests__/wounds-value-set-parity.test.ts) fails when either copy moves.

export const WOUND_ETIOLOGIES = [
  "pressure_injury",
  "diabetic_ulcer",
  "venous_ulcer",
  "arterial_ulcer",
  "surgical",
  "traumatic",
  "skin_tear",
  "malignant_fungating",
  "moisture_associated",
  "other",
] as const;
export type WoundEtiology = (typeof WOUND_ETIOLOGIES)[number];

/** Pressure-injury stages (NPIAP); only a pressure injury carries one. */
export const PRESSURE_STAGES = [
  "stage_1",
  "stage_2",
  "stage_3",
  "stage_4",
  "unstageable",
  "deep_tissue_injury",
] as const;
export type PressureStage = (typeof PRESSURE_STAGES)[number];

export const WOUND_BED_TISSUES = [
  "granulation",
  "slough",
  "eschar",
  "epithelializing",
  "necrotic",
  "hypergranulation",
  "bone_or_tendon_exposed",
] as const;
export type WoundBedTissue = (typeof WOUND_BED_TISSUES)[number];

export const EXUDATE_AMOUNTS = ["none", "scant", "small", "moderate", "large"] as const;
export type ExudateAmount = (typeof EXUDATE_AMOUNTS)[number];

export const EXUDATE_TYPES = ["serous", "serosanguineous", "sanguineous", "purulent"] as const;
export type ExudateType = (typeof EXUDATE_TYPES)[number];

export const WOUND_ODORS = ["none", "mild", "moderate", "strong"] as const;
export type WoundOdor = (typeof WOUND_ODORS)[number];

export const PERIWOUND_CONDITIONS = [
  "intact",
  "erythema",
  "macerated",
  "indurated",
  "edematous",
  "warm",
  "excoriated",
] as const;
export type PeriwoundCondition = (typeof PERIWOUND_CONDITIONS)[number];

export const WOUND_DRESSINGS = [
  "foam",
  "hydrocolloid",
  "alginate",
  "hydrogel",
  "gauze",
  "silver",
  "transparent_film",
  "negative_pressure",
  "other",
] as const;
export type WoundDressing = (typeof WOUND_DRESSINGS)[number];

export const WOUND_TRENDS = ["new", "improving", "stable", "worsening"] as const;
export type WoundTrend = (typeof WOUND_TRENDS)[number];

// ── M9-owned sets (not part of the note contract) ────────────────────────────────────────────────────────────────
export const WOUND_LATERALITIES = [
  "left",
  "right",
  "midline",
  "bilateral",
  "not_applicable",
] as const;
export type WoundLaterality = (typeof WOUND_LATERALITIES)[number];

/** Where the wound came from: present when the patient was admitted, or acquired under this agency's care. */
export const WOUND_ACQUIRED = ["present_on_admission", "acquired_in_care", "unknown"] as const;
export type WoundAcquired = (typeof WOUND_ACQUIRED)[number];

export const WOUND_STATUSES = ["open", "healed", "resolved_other"] as const;
export type WoundStatus = (typeof WOUND_STATUSES)[number];

/** The statuses a wound can be resolved to (every status but `open`). */
export const WOUND_RESOLUTIONS = ["healed", "resolved_other"] as const;
export type WoundResolution = (typeof WOUND_RESOLUTIONS)[number];

/** Observation lifecycle: a correction supersedes the observation it corrects (the M9 append-only convention). */
export const WOUND_OBSERVATION_STATUSES = ["active", "superseded"] as const;
export type WoundObservationStatus = (typeof WOUND_OBSERVATION_STATUSES)[number];

/**
 * Why an observation is corrected. Coded, never free text: a wound record carries no typed narrative, so nothing in it
 * can hold an identifier a sealing or screening layer would have to catch.
 */
export const WOUND_CORRECTION_REASONS = [
  "entered_on_wrong_wound",
  "measurement_error",
  "assessment_error",
  "wrong_visit",
  "other",
] as const;
export type WoundCorrectionReason = (typeof WOUND_CORRECTION_REASONS)[number];

export const isOneOf = <T extends string>(set: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (set as readonly string[]).includes(value);
