// @wardenx/assessments — FAST (Functional Assessment Staging) scorer (§4.3, §3.3, D1).
//
// FAST is ordinal, not additive: a discrete stage (1, 2, 3, 4, 5, 6a–6e, 7a–7f). The `score` column
// holds the monotonic stage INDEX (1..16) so the `fast_progression_30d` significant-change rule can
// compare two captures, while the stage label lives in `data` (§3.3). Hospice eligibility hinges on
// FAST ≥ 7a (index ≥ 11). `interpret()` renders the clinical descriptor for the stage.
import type { FastData, FastStage } from "../../scale-types";
import type { ScaleScorer } from "../scorer";

/** The canonical FAST progression order; the index (1-based) is the stored monotonic `score`. */
export const FAST_STAGE_ORDER: readonly FastStage[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6a",
  "6b",
  "6c",
  "6d",
  "6e",
  "7a",
  "7b",
  "7c",
  "7d",
  "7e",
  "7f",
];

/** The short clinical descriptor per stage (the chart/summary caption). */
const FAST_STAGE_LABEL: { readonly [K in FastStage]: string } = {
  "1": "no functional deficit",
  "2": "subjective deficit (forgets names)",
  "3": "deficits in demanding occupational tasks",
  "4": "needs help with complex tasks (finances, marketing)",
  "5": "needs help selecting clothing",
  "6a": "needs help dressing",
  "6b": "needs help bathing",
  "6c": "needs help toileting",
  "6d": "urinary incontinence",
  "6e": "fecal incontinence",
  "7a": "speech limited to ~6 words/day",
  "7b": "speech limited to ~1 word/day",
  "7c": "non-ambulatory",
  "7d": "cannot sit up unaided",
  "7e": "cannot smile",
  "7f": "cannot hold head up",
};

export const fastScorer: ScaleScorer<FastData> = {
  scaleType: "fast",
  scoreRange: [1, FAST_STAGE_ORDER.length], // [1, 16]
  score(d) {
    return FAST_STAGE_ORDER.indexOf(d.stage) + 1;
  },
  interpret(d) {
    return `FAST ${d.stage} — ${FAST_STAGE_LABEL[d.stage]}`;
  },
};
