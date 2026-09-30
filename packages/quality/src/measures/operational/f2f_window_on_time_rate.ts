// @wardenx/quality — operational measure: F2F compliance-window on-time rate (CoP 418.22). Pure. No IO.
// Rate of F2F compliance windows closed on time — no Medical-Director override, not late (higher is
// better). Source: M6 `ComplianceWindowCountsProvider.f2fWindowOnTimeCounts` (F-178, #248).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched F2F window on-time-close counts. */
export interface F2fWindowOnTimeRateInput extends ComputeMeasureInput {
  /** F2F compliance windows due to close in the window (denominator). */
  readonly f2fWindowsDue: number;
  /** F2F windows closed on time — no override, not late (numerator). */
  readonly f2fClosedOnTime: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the F2F-window on-time rate. Pure. */
export function computeF2fWindowOnTimeRate(
  input: F2fWindowOnTimeRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.f2fClosedOnTime,
    denominator: input.f2fWindowsDue,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "f2f_window_on_time_rate",
      f2fWindowsDue: input.f2fWindowsDue,
      f2fClosedOnTime: input.f2fClosedOnTime,
    },
  });
}
