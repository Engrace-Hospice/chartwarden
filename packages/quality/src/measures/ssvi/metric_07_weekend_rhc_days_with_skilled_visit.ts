// @wardenx/quality — SSVI metric 7: Weekend RHC days with a skilled visit as a percentage of total RHC days (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≤ 4.8% (25th pct). Rate = Saturday/Sunday RHC days with ≥ 1 signed skilled visit ÷ ALL RHC days (CMS's
// denominator is total RHC days, not weekend days). "Skilled" = nursing (RN/LPN) or medical social worker; CMS also
// counts therapy visits, which the encounter model has no discipline for — a therapy-only weekend day is not seen,
// so this estimate can only UNDER-count the numerator (err toward the point). Sources: M6 level-of-care spans, M8
// per-day skilled visits.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 7. */
export interface SsviMetric07Input extends ComputeMeasureInput {
  /** RHC days in the window (denominator). */
  readonly totalRhcDays: number;
  /** Saturday/Sunday RHC days with a skilled visit (numerator). */
  readonly weekendRhcDaysWithSkilledVisit: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_07). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 7. Pure. */
export function computeSsviMetric07(input: SsviMetric07Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_07",
    numerator: input.weekendRhcDaysWithSkilledVisit,
    denominator: input.totalRhcDays,
    rule: input.rule,
    snapshot: {
      totalRhcDays: input.totalRhcDays,
      weekendRhcDaysWithSkilledVisit: input.weekendRhcDaysWithSkilledVisit,
    },
  });
}
