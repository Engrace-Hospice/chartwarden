// @wardenx/quality — SSVI metric 1: Providing no Continuous Home Care and no General Inpatient Care (CMS-1851-F Table 9). Pure. No IO.
//
// The point is earned when the hospice provided NO CHC and NO GIP day in the period. Rate = election periods with
// at least one CHC/GIP day ÷ election periods; a rate of 0 earns the point (rule `lte 0`). Source: M6
// `LevelOfCarePeriodReader.chcOrGipCoverageCounts` (the HCI indicator 1 aggregate).
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched counts for SSVI metric 1. */
export interface SsviMetric01Input extends ComputeMeasureInput {
  /** Election periods active in the window (denominator). */
  readonly totalElectionPeriods: number;
  /** Election periods with at least one CHC or GIP day (numerator). */
  readonly periodsWithChcOrGipDay: number;
  /** The point rule ({@link SSVI_THRESHOLDS_FY2025_DATA}.metrics.metric_01). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 1. Pure. */
export function computeSsviMetric01(input: SsviMetric01Input): QualityMeasureValueResult {
  return ssviBinaryMetricResult({
    metric: "ssvi_metric_01",
    numerator: input.periodsWithChcOrGipDay,
    denominator: input.totalElectionPeriods,
    rule: input.rule,
    snapshot: {
      totalElectionPeriods: input.totalElectionPeriods,
      periodsWithChcOrGipDay: input.periodsWithChcOrGipDay,
    },
  });
}
