// @wardenx/quality — SSVI metric 3: Percent of the last two RHC days of life with visits (CMS-1851-F Table 9). Pure. No IO.
//
// CMS: "Percent of Beneficiaries who Died in Hospice and Last Two Days were RHC with at Least One Skilled Visit
// During Last Two Days". Point at ≤ 85.7% (25th pct). Denominator = decedents whose day of death and the day
// before were both RHC; numerator = those with ≥ 1 signed skilled visit (RN, LPN or MSW) on either day. Sources:
// M6 death census + level-of-care spans, M8 per-day skilled visits.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 3. */
export interface SsviMetric03Input extends ComputeMeasureInput {
  /** Decedents whose last two days of life were RHC (denominator). */
  readonly decedentsWithLastTwoDaysRhc: number;
  /** Of those, decedents with at least one skilled visit on either day (numerator). */
  readonly decedentsWithSkilledVisitInLastTwoDays: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_03). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 3. Pure. */
export function computeSsviMetric03(input: SsviMetric03Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_03",
    numerator: input.decedentsWithSkilledVisitInLastTwoDays,
    denominator: input.decedentsWithLastTwoDaysRhc,
    rule: input.rule,
    snapshot: {
      decedentsWithLastTwoDaysRhc: input.decedentsWithLastTwoDaysRhc,
      decedentsWithSkilledVisitInLastTwoDays: input.decedentsWithSkilledVisitInLastTwoDays,
    },
  });
}
