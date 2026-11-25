// packages/hearthnote/src/assembly/types.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The Layer-1 assembly contract. A `SelectionState` is the clinician's structured choices (the versioned
// JSON tree persisted as `hearthnote_selection`); `AssemblyContext` is the resolved patient/visit context
// (name, date, location, numeric-direct vitals) interpolated into phrase templates. `assembleLayer1`
// (see ./assemble) is a pure function of (template, selection, context) → byte-identical `narrative`.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";

/** A scalar interpolated into a `${slot}` — strings stay verbatim, numbers are stringified once. */
export type SlotValue = string | number;

/** One selected vocabulary entry within a section, with its resolved `${slot}` params. */
export interface EntrySelection {
  /** The `VocabEntry.code` chosen from the section's menu. */
  readonly code: string;
  /** Values for the entry's phrase-template `${slot}`s (numeric-direct values: vitals, scores). */
  readonly params?: Readonly<Record<string, SlotValue>>;
}

/** A section's selections plus any verbatim clinician free-text (preserved exactly — never grammared). */
export interface SectionSelection {
  /** Matches a `TemplateSection.id`. */
  readonly sectionId: string;
  /** Ordered entry selections (assembly preserves this order). */
  readonly entries: readonly EntrySelection[];
  /** Verbatim clinician prose appended after the section's assembled sentences (decrypted in-memory). */
  readonly freeText?: string;
}

/** The full versioned selection tree for one encounter (or addendum). */
export interface SelectionState {
  /** `${encounterType}:${discipline}` — must match the resolved template's key. */
  readonly templateKey: string;
  /** The `VOCAB_VERSION` the selections were authored against; pinned at first finalize (D11). */
  readonly vocabVersion: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  /** Sections in any order; assembly renders them in TEMPLATE order, not selection order. */
  readonly sections: readonly SectionSelection[];
}

/**
 * The visit's recorded vitals as stored (numeric-direct: never reworded, never judged). A field the clinician
 * did not capture is absent or null. Units are the stored `vital_unit` codes (`f`, `c`, `kg`, `lb`).
 */
export interface RecordedVitals {
  readonly bpSystolic?: number | null;
  readonly bpDiastolic?: number | null;
  readonly heartRate?: number | null;
  readonly respiratoryRate?: number | null;
  readonly temperature?: string | null;
  readonly temperatureUnit?: string | null;
  readonly spo2?: number | null;
  readonly painScore?: number | null;
  readonly weight?: string | null;
  readonly weightUnit?: string | null;
  /** Height as stored, with its unit (`cm` or `in`); BMI is the server-computed value, quoted, never recomputed here. */
  readonly height?: string | null;
  readonly heightUnit?: string | null;
  readonly bmi?: string | null;
  /** The weight recorded on the patient's previous visit, so the note can state the change. Absent when there is none. */
  readonly priorWeight?: {
    readonly value: string;
    readonly unit: string;
    readonly on: string;
  } | null;
}

// ─── WF09 recorded findings: ADLs, nutrition, wounds ─────────────────────────────────────────────────────────────────────────────
// Structured facts a clinician records on a visit, stated in the note by a deterministic sentence (like RecordedVitals), never
// through the vocabulary corpus. The value sets below are the contract between the capture routes, the screens and the note.

export const ADL_ITEMS = [
  "bathing",
  "dressing",
  "grooming",
  "toileting",
  "transferring",
  "ambulation",
  "eating",
] as const;
export type AdlItem = (typeof ADL_ITEMS)[number];

/** How much help the patient needed on the visit (MDS-style assistance scale). */
export const ADL_LEVELS = [
  "independent",
  "supervision",
  "limited_assist",
  "extensive_assist",
  "total_dependence",
  "did_not_occur",
] as const;
export type AdlLevel = (typeof ADL_LEVELS)[number];

export const CONTINENCE_LEVELS = [
  "continent",
  "occasionally_incontinent",
  "frequently_incontinent",
  "incontinent",
  "catheter_or_ostomy",
] as const;
export type ContinenceLevel = (typeof CONTINENCE_LEVELS)[number];

export const ADL_DEVICES = [
  "cane",
  "walker",
  "wheelchair",
  "hospital_bed",
  "mechanical_lift",
  "bedside_commode",
] as const;
export type AdlDevice = (typeof ADL_DEVICES)[number];

/** The functional status recorded on this visit. An item not assessed is absent. */
export interface RecordedAdl {
  readonly items?: Readonly<Partial<Record<AdlItem, AdlLevel>>>;
  readonly bladder?: ContinenceLevel | null;
  readonly bowel?: ContinenceLevel | null;
  readonly devices?: readonly AdlDevice[];
}

/**
 * The ADL levels recorded on the patient's previous signed visit, so the note can state the change in dependence since then.
 * Only the levels are kept (continence and devices are not part of the score).
 */
export interface PriorRecordedAdl {
  readonly items?: RecordedAdl["items"];
  /** That visit's service date, as the caller formatted it (assembly never computes time). */
  readonly on: string;
}

export const APPETITE_LEVELS = ["good", "fair", "poor", "none"] as const;
export type AppetiteLevel = (typeof APPETITE_LEVELS)[number];

export const FLUID_INTAKE_LEVELS = ["adequate", "decreased", "minimal"] as const;
export type FluidIntakeLevel = (typeof FLUID_INTAKE_LEVELS)[number];

export const SWALLOWING_LEVELS = [
  "no_difficulty",
  "difficulty_solids",
  "difficulty_liquids",
  "difficulty_solids_and_liquids",
  "unable_to_swallow",
] as const;
export type SwallowingLevel = (typeof SWALLOWING_LEVELS)[number];

export const NUTRITION_SUPPORTS = [
  "none",
  "oral_supplements",
  "tube_feeding",
  "parenteral",
] as const;
export type NutritionSupport = (typeof NUTRITION_SUPPORTS)[number];

/** The nutrition and hydration status recorded on this visit. A field not assessed is absent. */
export interface RecordedNutrition {
  readonly appetite?: AppetiteLevel | null;
  /** Share of meals eaten, a whole percent 0 to 100. */
  readonly mealIntakePercent?: number | null;
  readonly fluidIntake?: FluidIntakeLevel | null;
  readonly swallowing?: SwallowingLevel | null;
  readonly support?: NutritionSupport | null;
}

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

/** One wound as assessed on this visit. `site` is the display phrase for the location ("sacrum", "left heel"). */
export interface RecordedWound {
  readonly site: string;
  readonly etiology: WoundEtiology;
  readonly stage?: PressureStage | null;
  /** Measurements in centimetres, as stored. */
  readonly lengthCm?: number | null;
  readonly widthCm?: number | null;
  readonly depthCm?: number | null;
  readonly undermining?: boolean | null;
  readonly woundBed?: readonly WoundBedTissue[];
  readonly exudateAmount?: ExudateAmount | null;
  readonly exudateType?: ExudateType | null;
  readonly odor?: WoundOdor | null;
  readonly periwound?: readonly PeriwoundCondition[];
  /** Pain at the wound, 0 to 10. */
  readonly painScore?: number | null;
  readonly dressing?: WoundDressing | null;
  readonly dressingChanged?: boolean | null;
  readonly infectionSigns?: boolean | null;
  readonly trend?: WoundTrend | null;
}

/** The recorded fall a follow-up visit is linked to: the incident's org-local date, copied when the link was made. */
export interface LinkedFall {
  readonly occurredOn: string;
}

/** The resolved patient/visit context interpolated into phrases (the `${slot}` value source of record). */
export interface AssemblyContext {
  /** How the patient is referred to in the narrative (Layer-1 uses the real name; Layer-2 minimizes). */
  readonly patient: string;
  /** Org-local service date string (already formatted by the caller; assembly never computes time). */
  readonly serviceDate: string;
  readonly location?: string;
  /** Numeric-direct vitals/scores exposed as `${slot}`s; never paraphrased by Layer 2 (D7 hard-block). */
  readonly vitals?: Readonly<Record<string, SlotValue>>;
  /** The vitals captured on this visit. Rendered once, under the template's vitals-summary section. */
  readonly recordedVitals?: RecordedVitals;
  /** Functional status recorded on this visit. Rendered under the template's ADL-summary section. */
  readonly recordedAdl?: RecordedAdl;
  /** The ADL levels of the patient's previous signed visit, so the functional-status sentence can state the change since then. */
  readonly priorAdl?: PriorRecordedAdl;
  /** Nutrition and hydration recorded on this visit. Rendered under the template's nutrition-summary section. */
  readonly recordedNutrition?: RecordedNutrition;
  /** The wounds assessed on this visit, in the order recorded. Rendered under the template's wound-summary section. */
  readonly recordedWounds?: readonly RecordedWound[];
  /** The fall this visit follows up, if the clinician linked one. Stated only beside the follow-up-after-a-fall reason. */
  readonly linkedFall?: LinkedFall;
}

/** The deterministic Layer-1 output. */
export interface AssemblyResult {
  /** The byte-identical assembled narrative (same inputs → same bytes). */
  readonly narrative: string;
  /** Section ids that produced content, in render order (omits empty sections). */
  readonly sectionsAssembled: readonly string[];
  /** The vocab version the narrative was assembled against (echoed from the selection). */
  readonly vocabVersion: string;
}
