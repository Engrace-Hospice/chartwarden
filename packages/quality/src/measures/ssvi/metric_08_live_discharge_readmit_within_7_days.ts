// @wardenx/quality — SSVI metric 8: Percentage of live discharges where beneficiaries return to the same hospice in seven days (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≥ 15% (75th pct). Rate = live discharges followed by a new admission of the same patient to THIS agency
// within 7 days of the discharge date ÷ live discharges. Source: M6 `DischargeReader.ssviDischargeCounts`.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 8. */
export interface SsviMetric08Input extends ComputeMeasureInput {
  /** Live discharges in the window (denominator). */
  readonly liveDischarges: number;
  /** Of those, readmitted to this hospice within 7 days (numerator). */
  readonly liveDischargesReadmittedWithin7Days: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_08). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 8. Pure. */
export function computeSsviMetric08(input: SsviMetric08Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_08",
    numerator: input.liveDischargesReadmittedWithin7Days,
    denominator: input.liveDischarges,
    rule: input.rule,
    snapshot: {
      liveDischarges: input.liveDischarges,
      liveDischargesReadmittedWithin7Days: input.liveDischargesReadmittedWithin7Days,
    },
  });
}
