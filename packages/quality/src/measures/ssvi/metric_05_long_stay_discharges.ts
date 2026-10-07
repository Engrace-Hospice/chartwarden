// @wardenx/quality — SSVI metric 5: Percentage of discharges with a length of stay over 180 days (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≥ 33.2% (75th pct). Rate = discharges (live AND death) whose length of stay — admission date to
// discharge date — exceeds 180 days ÷ all discharges. Source: M6 `DischargeReader.ssviDischargeCounts`.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 5. */
export interface SsviMetric05Input extends ComputeMeasureInput {
  /** All discharges in the window (denominator). */
  readonly totalDischarges: number;
  /** Discharges with a length of stay over 180 days (numerator). */
  readonly dischargesWithLosOver180: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_05). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 5. Pure. */
export function computeSsviMetric05(input: SsviMetric05Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_05",
    numerator: input.dischargesWithLosOver180,
    denominator: input.totalDischarges,
    rule: input.rule,
    snapshot: {
      totalDischarges: input.totalDischarges,
      dischargesWithLosOver180: input.dischargesWithLosOver180,
    },
  });
}
