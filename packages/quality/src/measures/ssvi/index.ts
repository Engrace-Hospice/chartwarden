// @chartwarden/quality — Service and Spending Variation Index (SSVI) COMPOSITE (0-16) + family barrel. Pure. No IO.
//
// The total is the SUM of the nine metrics' points: eight binary metrics (0/1) plus non-hospice spending (0-8).
// A total ≥ 13 is an outlier (FR-F: ≈ the 99th percentile). Higher = more CMS concern — the reverse of the HCI.
//
// Withholding rule (the HCI composite's, for the same reason): a metric that is structurally unavailable, or not
// yet computed for the period, SUSPENDS the total rather than contributing 0. Metric 9 alone spans 8 of the 16
// points, so "7 of 16 without metric 9" is not a score — it is a lower bound. The suppressed row still records
// that lower bound and the most the total could be (`partialScoreLowerBound` / `maxPossibleScore`), which is
// useful on its own: a lower bound already ≥ 13 means an outlier whatever metric 9 turns out to be.
//
// Every SSVI value is an INTERNAL ESTIMATE ({@link SSVI_INTERNAL_ESTIMATE_NOTICE}); CMS publishes the official one.
import type { QualityMeasureValueResult } from "../result";
import { isDataUnavailable, unavailableResult } from "../result";
import { ssviPointsOf } from "./point_result";
import {
  SSVI_INTERNAL_ESTIMATE_NOTICE,
  type SsviMetricKey,
  type SsviThresholdTable,
} from "./thresholds";

export * from "./availability";
export * from "./thresholds";
export * from "./point_result";
export * from "./day_reductions";
export * from "./metric_01_no_chc_or_gip";
export * from "./metric_02_rhc_days_in_nursing_facility";
export * from "./metric_03_last_two_rhc_days_with_visit";
export * from "./metric_04_live_discharge_share";
export * from "./metric_05_long_stay_discharges";
export * from "./metric_06_skilled_nursing_minutes_rhc";
export * from "./metric_07_weekend_rhc_days_with_skilled_visit";
export * from "./metric_08_live_discharge_readmit_within_7_days";
export * from "./metric_09_non_hospice_spending";

/** The nine metric keys in CMS order, with their measure codes. */
export const SSVI_METRIC_MEASURE_CODES: ReadonlyArray<readonly [SsviMetricKey, string]> = [
  ["metric_01", "ssvi_metric_01"],
  ["metric_02", "ssvi_metric_02"],
  ["metric_03", "ssvi_metric_03"],
  ["metric_04", "ssvi_metric_04"],
  ["metric_05", "ssvi_metric_05"],
  ["metric_06", "ssvi_metric_06"],
  ["metric_07", "ssvi_metric_07"],
  ["metric_08", "ssvi_metric_08"],
  ["metric_09", "ssvi_metric_09"],
];

/** The most points each metric can contribute (metric 9 is the octile, 0-8). */
const MAX_POINTS: Readonly<Record<SsviMetricKey, number>> = {
  metric_01: 1,
  metric_02: 1,
  metric_03: 1,
  metric_04: 1,
  metric_05: 1,
  metric_06: 1,
  metric_07: 1,
  metric_08: 1,
  metric_09: 8,
};

/** What the composite reports when a metric could not contribute. */
export const SSVI_COMPOSITE_INCOMPLETE_REASON =
  "The SSVI total is the sum of nine metrics' points (0-16), so a partial sum is a lower bound, not a score. It is withheld until all nine contribute.";

/** The nine metric results, keyed by metric; `null` = not yet computed for the period. */
export type SsviMetricResults = Readonly<Record<SsviMetricKey, QualityMeasureValueResult | null>>;

/** Input to the SSVI composite. */
export interface SsviCompositeInput {
  readonly metrics: SsviMetricResults;
  readonly thresholds: SsviThresholdTable;
}

/**
 * Compute the SSVI total (0-16) from the nine metric results. numerator = total, denominator = 16,
 * rate = total / 16; `thresholdMet` = NOT an outlier (total < 13), band red for an outlier. Pure.
 */
export function computeSsviScore(input: SsviCompositeInput): QualityMeasureValueResult {
  const { thresholds } = input;
  const perMetricPoints: Record<string, number | null> = {};
  const unavailable: string[] = [];
  const notComputed: string[] = [];
  let total = 0;
  let maxMissing = 0;
  for (const [key] of SSVI_METRIC_MEASURE_CODES) {
    const result = input.metrics[key];
    if (result === undefined || result === null) {
      notComputed.push(key);
      perMetricPoints[key] = null;
      maxMissing += MAX_POINTS[key];
      continue;
    }
    if (isDataUnavailable(result)) {
      unavailable.push(key);
      perMetricPoints[key] = null;
      maxMissing += MAX_POINTS[key];
      continue;
    }
    const points = ssviPointsOf(result);
    perMetricPoints[key] = points;
    total += points;
  }

  const common = {
    indicator: "ssvi_composite",
    internalEstimate: true,
    internalEstimateNotice: SSVI_INTERNAL_ESTIMATE_NOTICE,
    thresholdDataFiscalYear: thresholds.dataFiscalYear,
    thresholdSource: thresholds.publishedIn,
    maxScore: thresholds.maxScore,
    outlierScore: thresholds.outlierScore,
    perMetricPoints,
  };
  const threshold = {
    value: thresholds.outlierScore / thresholds.maxScore,
    direction: "lte" as const,
    label: `SSVI total below the outlier cut (${thresholds.outlierScore}/${thresholds.maxScore})`,
  };

  if (unavailable.length > 0 || notComputed.length > 0) {
    return unavailableResult({
      threshold,
      unavailable: {
        reason: SSVI_COMPOSITE_INCOMPLETE_REASON,
        requires:
          unavailable.length > 0
            ? `an input source for ${unavailable.join(", ")} (see SSVI_UNAVAILABLE_METRICS)`
            : `a computed value for ${notComputed.join(", ")} in this period`,
      },
      snapshot: {
        ...common,
        partialScoreLowerBound: total,
        maxPossibleScore: total + maxMissing,
        outlierRegardlessOfMissing: total >= thresholds.outlierScore,
        unavailableMetrics: unavailable,
        notYetComputedMetrics: notComputed,
      },
    });
  }

  const outlier = total >= thresholds.outlierScore;
  return {
    numerator: total,
    denominator: thresholds.maxScore,
    rate: total / thresholds.maxScore,
    thresholdMet: !outlier,
    thresholdValue: thresholds.outlierScore / thresholds.maxScore,
    bandColor: outlier ? "red" : "green",
    computationSnapshot: { ...common, score: total, outlier },
  };
}
