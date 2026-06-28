// @wardenx/quality — operational/HQRP measure: HOPE submission acceptance rate. Pure. No IO.
// Rate of HOPE assessments accepted by iQIES on submission (higher is better). A quarterly rate < 90% is
// the APU-penalty signal (§1.3). Source: M10 `HopeSubmissionProvider`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched HOPE submission-acceptance counts. */
export interface HopeSubmissionAcceptanceRateInput extends ComputeMeasureInput {
  /** HOPE assessments submitted to iQIES in the window (denominator). */
  readonly submissions: number;
  /** Submissions accepted by iQIES (numerator). */
  readonly acceptedSubmissions: number;
  /** The per-FY/agency target (higher-is-better; CMS APU floor is 90%). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the HOPE-submission-acceptance rate. Pure. */
export function computeHopeSubmissionAcceptanceRate(
  input: HopeSubmissionAcceptanceRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.acceptedSubmissions,
    denominator: input.submissions,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "hope_submission_acceptance_rate",
      submissions: input.submissions,
      acceptedSubmissions: input.acceptedSubmissions,
    },
  });
}
