// @chartwarden/types — the advisory ESAS-r symptom prompt of the visit-note composer.
//
// ONE place for the nine ESAS-r items, the one sourced cut-off behind the prompt, and the pure functions that read it. The composer's
// Right Panel (apps/web, `esas-symptom-prompt.tsx`) renders it; the M9 series route (`apps/backend/src/modules/09-assessments`) carries
// the nine item scores that feed it. Nothing here is read by the finalize or sign gate.
//
// ADVISORY ONLY, and deliberately small. The prompt lists the items at or above ONE cut-off and says "consider a fuller assessment of
// this symptom". It has NO severity tier or band, NO total-score band, NO "notify the physician" wording, NO automatic action and it
// blocks nothing. Do not add a second rule here without a second source and a clinical sign-off. Section 8 of
// `docs/clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md` was signed off by Lora, RN on 2026-11-25; the evidence caveats
// (one cut-off for all nine items, abstract-only sources) are in `docs/research/ESAS_R_CUTOFFS_RESEARCH.md`, so do not read the number as a
// clinical rule beyond its stated source.
//
// The M9 alert at 7 (`ESAS_R_SEVERE_ITEM_MIN_SCORE`, packages/assessments/src/scales/esas-r/severe-item.ts) is a SEPARATE platform rule with its
// own sources and limits. It raises a significant-change alert and words the assessment record ("severe (≥7): pain", shown on the M9
// assessment screens); this prompt does not show it and makes no severity claim of its own.

/** The nine ESAS-r items in the published order. The keys are the `EsasrData` field names (`@chartwarden/assessments`). */
export const ESAS_R_ITEM_KEYS = [
  "pain",
  "tiredness",
  "drowsiness",
  "nausea",
  "lackOfAppetite",
  "shortnessOfBreath",
  "depression",
  "anxiety",
  "wellbeing",
] as const;

export type EsasrItemKey = (typeof ESAS_R_ITEM_KEYS)[number];

/** How each item reads on screen: the ESAS-r published item names. */
export const ESAS_R_ITEM_LABELS: Readonly<Record<EsasrItemKey, string>> = {
  pain: "Pain",
  tiredness: "Tiredness",
  drowsiness: "Drowsiness",
  nausea: "Nausea",
  lackOfAppetite: "Lack of appetite",
  shortnessOfBreath: "Shortness of breath",
  depression: "Depression",
  anxiety: "Anxiety",
  wellbeing: "Wellbeing",
};

/** The nine item scores of one ESAS-r reading. ESAS-r convention: 0 is best and 10 is worst for every item, wellbeing included. */
export type EsasrItemScores = Readonly<Record<EsasrItemKey, number>>;

/** The lowest and highest score of an ESAS-r item. */
export const ESAS_R_ITEM_SCORE_MIN = 0;
export const ESAS_R_ITEM_SCORE_MAX = 10;

/**
 * An item scoring this much or more (0 to 10 scale) is worth a fuller assessment of that symptom. Type: research benchmark.
 * Source: Oldenmenger WH et al., J Pain Symptom Manage 2013;45:1083-93 (systematic review; concludes a symptom score of 4 or more is
 * recommended as a trigger for a more comprehensive symptom assessment). LIMITS the review states: evidence is missing for 7 of the 9
 * items, and it cautions against fixed cut-offs in quality indicators and guidelines. So the cut-off varies by symptom and population
 * and is not a severity rating; the screen says so.
 */
export const ESAS_R_FULLER_ASSESSMENT_MIN_SCORE = 4;

/** The prompt's type and source, as the screen words them (a research benchmark; see {@link ESAS_R_FULLER_ASSESSMENT_MIN_SCORE}). */
export const ESAS_R_FULLER_ASSESSMENT_BASIS_LABEL = "Research benchmark";
export const ESAS_R_FULLER_ASSESSMENT_SOURCE =
  "Oldenmenger WH et al., J Pain Symptom Manage 2013;45:1083-93 (systematic review: a symptom score of 4 or more is recommended as a trigger for a more comprehensive symptom assessment; evidence is missing for 7 of the 9 items)";

/** One item at or above the cut-off. */
export interface EsasrPromptItem {
  readonly key: EsasrItemKey;
  readonly label: string;
  readonly score: number;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A score is a finite number from 0 to 10; anything else is not a reading. */
const isItemScore = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= ESAS_R_ITEM_SCORE_MIN &&
  value <= ESAS_R_ITEM_SCORE_MAX;

/**
 * The items of a reading that are at or above the cut-off, in the published order. Tolerant on purpose: a missing, non-numeric,
 * non-finite or out-of-range value is ignored, a key that is not one of the nine is ignored, and input that is not a record answers an
 * empty list. It never throws.
 */
export function esasrItemsForFullerAssessment(itemScores: unknown): readonly EsasrPromptItem[] {
  if (!isRecord(itemScores)) return [];
  return ESAS_R_ITEM_KEYS.flatMap((key): EsasrPromptItem[] => {
    const score = itemScores[key];
    return isItemScore(score) && score >= ESAS_R_FULLER_ASSESSMENT_MIN_SCORE
      ? [{ key, label: ESAS_R_ITEM_LABELS[key], score }]
      : [];
  });
}

/**
 * The nine numeric item scores of a recorded ESAS-r (`data` of the assessment row), and nothing else: `otherSymptom`,
 * `otherSymptomText`, `reportedBy` and every other key are dropped here, so a free-text note can never ride along. `undefined` unless
 * all nine items are numbers from 0 to 10 (a partial record is not a reading the prompt can use).
 */
export function esasrItemScoresFrom(data: unknown): EsasrItemScores | undefined {
  if (!isRecord(data)) return undefined;
  const entries = ESAS_R_ITEM_KEYS.map((key) => [key, data[key]] as const);
  if (!entries.every(([, score]) => isItemScore(score))) return undefined;
  return Object.fromEntries(entries) as EsasrItemScores;
}
