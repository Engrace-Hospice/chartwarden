// @wardenx/assessments — per-scale `data` payload shapes (§3.3 `clinical_assessment.data` jsonb, §4.3).
//
// D1: one shared base table + per-scale `data jsonb`. The cross-module ENUM/seam surface lives in the
// leaf `@wardenx/types` (`ScaleType` etc.); this FEATURE package owns the rich per-scale shapes the
// scoring + TypeBox modules build on. M9-T01 pins the six §4.3-specified shapes (the representative set
// the spec fixes); the remaining eight scales' shapes + each scale's `score()`/`interpret()`/
// `eligibility`/`thresholds`/`loinc` land per-folder under `scales/<scale>/` in M9-T03.

import type { ScaleType } from "@wardenx/types";

export type { ScaleType };

/** Shared per-`data` free-text the scoring path ignores (denylisted from audit value capture, §8.1). */
export interface ScaleDataNotes {
  readonly notes?: string;
}

// ── PPS — Palliative Performance Scale (server computes 0..100 in 10-point steps from the row, §4.3) ──
export type PpsAmbulation =
  | "full"
  | "reduced"
  | "mainly_sit_lie"
  | "mainly_in_bed"
  | "totally_bed_bound";
export type PpsActivity =
  | "normal"
  | "reduced"
  | "unable_normal_work"
  | "unable_hobby_work"
  | "unable_any_work";
export type PpsSelfCare =
  | "full"
  | "occasional_assist"
  | "considerable_assist"
  | "mainly_assist"
  | "total_care";
export type PpsIntake = "normal" | "reduced" | "minimal_to_sips" | "mouth_care_only";
export type PpsConsciousness =
  | "full"
  | "full_or_confusion"
  | "full_or_drowsy_or_confusion"
  | "drowsy_or_coma";

export interface PpsData extends ScaleDataNotes {
  readonly ambulation: PpsAmbulation;
  readonly activity: PpsActivity;
  readonly selfCare: PpsSelfCare;
  readonly intake: PpsIntake;
  readonly consciousness: PpsConsciousness;
}

// ── ESAS-r — Edmonton Symptom Assessment System (revised); 9 symptoms 0..10 + optional 'other' (§4.3) ─
export type EsasrReportedBy = "patient" | "caregiver" | "clinician_observed";

export interface EsasrData {
  readonly pain: number;
  readonly tiredness: number;
  readonly drowsiness: number;
  readonly nausea: number;
  readonly lackOfAppetite: number;
  readonly shortnessOfBreath: number;
  readonly depression: number;
  readonly anxiety: number;
  /** 0=best, 10=worst per ESAS-r convention. */
  readonly wellbeing: number;
  readonly otherSymptom?: {
    readonly label: string;
    readonly severity: number;
  };
  readonly reportedBy: EsasrReportedBy;
  /** Free-text symptom note — denylisted from audit value capture (§8.1). */
  readonly otherSymptomText?: string;
}

// ── PAINAD — Pain Assessment in Advanced Dementia; 5 items 0..2 each, total 0..10 (§4.3) ──────────────
export interface PainadData extends ScaleDataNotes {
  readonly breathing: number;
  readonly negativeVocalization: number;
  readonly facialExpression: number;
  readonly bodyLanguage: number;
  readonly consolability: number;
}

// ── MELD — Model for End-stage Liver Disease (server computes MELD or MELD-Na, §4.3) ──────────────────
export interface MeldData extends ScaleDataNotes {
  readonly creatinineMgDl: number;
  readonly bilirubinMgDl: number;
  readonly inr: number;
  /** Present ⇒ MELD-Na. */
  readonly sodiumMeqL?: number;
  readonly onDialysisTwiceLastWeek?: boolean;
}

// ── FAST — Functional Assessment Staging; discrete stages 1..5, 6a-6e, 7a-7f (§4.3) ───────────────────
export type FastStage =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6a"
  | "6b"
  | "6c"
  | "6d"
  | "6e"
  | "7a"
  | "7b"
  | "7c"
  | "7d"
  | "7e"
  | "7f";

export interface FastData extends ScaleDataNotes {
  readonly stage: FastStage;
}

// ── AIMS — Abnormal Involuntary Movement Scale; 12 items 0..4 + judgment items (§4.3); SUD-gated reads ─
export interface AimsData extends ScaleDataNotes {
  readonly facialMuscles: number;
  readonly lipsAndPerioral: number;
  readonly jaw: number;
  readonly tongue: number;
  readonly upperLimbs: number;
  readonly lowerLimbs: number;
  readonly truncal: number;
  readonly globalSeverity: number;
  readonly globalIncapacitation: number;
  readonly patientAwareness: number;
  readonly currentProblemsTeeth: boolean;
  readonly dentalProblems: boolean;
}

/**
 * The §4.3-pinned per-scale `data` shapes (the representative set the spec fixes). The remaining eight
 * scales (`kps`, `flacc`, `nyha`, `bode`, `flacker`, `gds`, `braden`, `morse`) get their authoritative
 * `data` shape + TypeBox in their `scales/<scale>/schema.ts` module in M9-T03; until then their `data`
 * resolves to the open {@link UnscaledData} placeholder so the discriminated union compiles.
 */
export interface ScaleDataByType {
  readonly pps: PpsData;
  readonly esas_r: EsasrData;
  readonly painad: PainadData;
  readonly meld: MeldData;
  readonly fast: FastData;
  readonly aims: AimsData;
}

/** Placeholder for a scale whose authoritative `data` shape lands in M9-T03 (per-scale `schema.ts`). */
export type UnscaledData = ScaleDataNotes & { readonly [k: string]: unknown };

/** The full per-scale `data` resolver: pinned shape where §4.3 fixes it, open placeholder otherwise. */
export type ScaleData<T extends ScaleType> = T extends keyof ScaleDataByType
  ? ScaleDataByType[T]
  : UnscaledData;
