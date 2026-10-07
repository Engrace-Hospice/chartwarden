// @wardenx/quality — SSVI metric 4: Percentage of total discharges that are live discharges (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≥ 47.5% (75th pct). Rate = live discharges (every discharge type except death: revocation, transfer,
// no longer terminally ill, moved, for cause) ÷ all discharges. Source: M6 `DischargeReader.ssviDischargeCounts`.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 4. */
export interface SsviMetric04Input extends ComputeMeasureInput {
  /** All discharges in the window, live and death (denominator). */
  readonly totalDischarges: number;
  /** Discharges other than death (numerator). */
  readonly liveDischarges: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_04). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 4. Pure. */
export function computeSsviMetric04(input: SsviMetric04Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_04",
    numerator: input.liveDischarges,
    denominator: input.totalDischarges,
    rule: input.rule,
    snapshot: {
      totalDischarges: input.totalDischarges,
      liveDischarges: input.liveDischarges,
    },
  });
}
