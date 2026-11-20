// @chartwarden/quality — SSVI metric 5: Percentage of discharges with a length of stay of 180 days or more (CMS-1851-F Table 9). Pure. No IO.
//
// Point at or above the 75th-percentile cut (`thresholds.ts`). Rate = discharges (live AND death, transfers
// excluded as CMS does) whose length of stay — admission date to discharge date — is 180 days or more ÷ all such
// discharges. Source: M6 `DischargeReader.ssviDischargeCounts`.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 5. */
export interface SsviMetric05Input extends ComputeMeasureInput {
  /** All non-transfer discharges in the window (denominator). */
  readonly totalDischarges: number;
  /** Non-transfer discharges with a length of stay of 180 days or more (numerator). */
  readonly dischargesWithLos180OrMore: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_05). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 5. Pure. */
export function computeSsviMetric05(input: SsviMetric05Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_05",
    numerator: input.dischargesWithLos180OrMore,
    denominator: input.totalDischarges,
    rule: input.rule,
    snapshot: {
      totalDischarges: input.totalDischarges,
      dischargesWithLos180OrMore: input.dischargesWithLos180OrMore,
    },
  });
}
