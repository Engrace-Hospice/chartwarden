// @wardenx/quality — Hospice Care Index (HCI) COMPOSITE score (§1.1, D2). Pure. No IO.
//
// The HCI is the COUNT of the ten indicators whose rate met the CMS threshold for the period (max 10). An
// `insufficient_n` indicator (no reportable rate) counts as NOT-met for the composite (only `thresholdMet
// === true` scores). The composite is "above the national average" when the score ≥ the per-FY cut
// (D15: ≥ 7/10). This file composes the ten per-indicator results — it does NOT re-fetch or recompute
// them; the worker computes each indicator, then hands the ten results here.
import type { QualityMeasureValueResult } from "../result";
import { ratioResult } from "../result";
import type { HciIndicatorKey, HciThresholdTable } from "./thresholds";

export * from "./thresholds";
export * from "./indicator_01_continuous_or_gip";
export * from "./indicator_02_gaps_in_skilled_nursing";
export * from "./indicator_03_early_live_discharges";
export * from "./indicator_04_late_live_discharges";
export * from "./indicator_05_burdensome_transitions_type1";
export * from "./indicator_06_burdensome_transitions_type2";
export * from "./indicator_07_per_beneficiary_spending";
export * from "./indicator_08_skilled_nursing_minutes_per_rhc";
export * from "./indicator_09_skilled_nursing_minutes_weekends";
export * from "./indicator_10_visits_near_death";

/** The HCI score above which the composite is banded yellow rather than red (mid-band floor). */
export const HCI_MID_BAND_SCORE = 5;

/** The ten per-indicator results, keyed by indicator (the worker computes each, then composes here). */
export type HciIndicatorResults = Readonly<Record<HciIndicatorKey, QualityMeasureValueResult>>;

/** Input to the HCI composite: the ten indicator results + the per-FY threshold table. */
export interface HciCompositeInput {
  /** The ten already-computed per-indicator results. */
  readonly indicators: HciIndicatorResults;
  /** The per-FY threshold table supplying the above-average composite cut. */
  readonly thresholds: HciThresholdTable;
}

const HCI_INDICATOR_KEYS: readonly HciIndicatorKey[] = [
  "indicator_01",
  "indicator_02",
  "indicator_03",
  "indicator_04",
  "indicator_05",
  "indicator_06",
  "indicator_07",
  "indicator_08",
  "indicator_09",
  "indicator_10",
];

/**
 * Compute the HCI composite score (0–10) from the ten indicator results. The numerator is the met-count,
 * the denominator is 10, the rate is `met / 10`, and the band is green at/above the above-average cut,
 * yellow at/above {@link HCI_MID_BAND_SCORE}, else red. Pure.
 */
export function computeHciScore(input: HciCompositeInput): QualityMeasureValueResult {
  const perIndicator: Record<string, boolean | null> = {};
  let metCount = 0;
  for (const key of HCI_INDICATOR_KEYS) {
    const met = input.indicators[key].thresholdMet;
    perIndicator[key] = met;
    if (met === true) metCount += 1;
  }

  const aboveAverageCut = input.thresholds.compositeAboveAverageScore;
  const base = ratioResult({
    numerator: metCount,
    denominator: HCI_INDICATOR_KEYS.length,
    snapshot: {
      indicator: "hci_composite",
      fiscalYear: input.thresholds.fiscalYear,
      score: metCount,
      maxScore: HCI_INDICATOR_KEYS.length,
      aboveAverageCut,
      perIndicatorThresholdMet: perIndicator,
    },
  });

  const bandColor =
    metCount >= aboveAverageCut ? "green" : metCount >= HCI_MID_BAND_SCORE ? "yellow" : "red";

  return { ...base, thresholdMet: metCount >= aboveAverageCut, bandColor };
}
