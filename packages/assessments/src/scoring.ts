// @wardenx/assessments — server-authoritative scoring dispatch (§4.3, §10 task #4, D6).
//
// The single entry point the recording service (M9-T05 `score-assessment.ts`) calls: dispatch over the
// captured `scaleType` to the per-scale `score()`/`interpret()`, then enforce the D6 composite-score
// sanity (the computed value must fall in the scale's published `scoreRange`, else a scoring-function
// bug → `SCORE_OUT_OF_RANGE` 500, never a 4xx). The API ignores any client-sent `score` entirely — this
// is the only place a score is produced. M9-T03 registers the four representative scorers the plan pins
// (PPS / FAST / PAINAD / ESAS-r); a request for a not-yet-registered scale raises
// `SCALE_SCORER_UNAVAILABLE` (500) until its module lands with the routes/tests.
import type { ScaleType } from "@wardenx/types";
import type { ScaleData } from "./scale-types";
import type { AnyScaleScorer, ScaleScoreResult } from "./scales/scorer";
import { AssessmentStateError } from "./errors";
import { ppsScorer } from "./scales/pps";
import { fastScorer } from "./scales/fast";
import { painadScorer } from "./scales/painad";
import { esasrScorer } from "./scales/esas-r";

/** The registered per-scale scorers. Concrete `ScaleScorer<PpsData>` etc. are assignable to the erased
 * `AnyScaleScorer` (contravariant params), letting the registry stay heterogeneous without an `any`. The
 * ten unlisted scales' scorers register here when their modules land. */
const SCALE_SCORERS: { readonly [K in ScaleType]?: AnyScaleScorer } = {
  pps: ppsScorer,
  fast: fastScorer,
  painad: painadScorer,
  esas_r: esasrScorer,
};

/** Whether a scale's scorer is registered (the form-gating + test harness checks this). */
export function hasScorer(scaleType: ScaleType): boolean {
  return SCALE_SCORERS[scaleType] !== undefined;
}

/**
 * Score a captured scale: server-authoritative (D6). Returns the canonical numeric + interpretation, or
 * raises `SCALE_SCORER_UNAVAILABLE` (scale not yet built) / `SCORE_OUT_OF_RANGE` (computed value outside
 * the published range — a scoring bug). `data` is the discriminated-union payload narrowed at the route.
 */
export function scoreAssessment<T extends ScaleType>(
  scaleType: T,
  data: ScaleData<T>,
): ScaleScoreResult {
  const scorer = SCALE_SCORERS[scaleType];
  if (scorer === undefined) {
    throw new AssessmentStateError(
      "SCALE_SCORER_UNAVAILABLE",
      `No scoring module registered for scale '${scaleType}'.`,
    );
  }
  const score = scorer.score(data as never);
  const [min, max] = scorer.scoreRange;
  if (!Number.isFinite(score) || score < min || score > max) {
    throw new AssessmentStateError(
      "SCORE_OUT_OF_RANGE",
      `Computed ${scaleType} score ${score} is outside the published range [${min}, ${max}].`,
    );
  }
  return { score, interpretation: scorer.interpret(data as never) };
}
