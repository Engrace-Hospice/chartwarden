// @wardenx/quality — SSVI metric 2: Percentage of RHC days provided in a nursing home or skilled nursing facility (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≥ 40%. Rate = billed RHC days whose site of service is a nursing facility (Q5003) or SNF (Q5004) ÷
// billed RHC days. Source: M23 `ClaimLineReader.claimLineRollupForPeriod` (MAC-accepted 0651 lines by Q-code) —
// billed days, the same claims basis CMS uses.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 2. */
export interface SsviMetric02Input extends ComputeMeasureInput {
  /** Billed RHC days in the window (denominator). */
  readonly totalRhcDays: number;
  /** Of those, days with site of service Q5003 (NF/LTC) or Q5004 (SNF) (numerator). */
  readonly rhcDaysInNursingFacility: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_02). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 2. Pure. */
export function computeSsviMetric02(input: SsviMetric02Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_02",
    numerator: input.rhcDaysInNursingFacility,
    denominator: input.totalRhcDays,
    rule: input.rule,
    snapshot: {
      totalRhcDays: input.totalRhcDays,
      rhcDaysInNursingFacility: input.rhcDaysInNursingFacility,
    },
  });
}
