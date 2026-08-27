// @wardenx/quality — Hospice Care Index (HCI) COMPOSITE score (§1.1, D2). Pure. No IO.
//
// The HCI is the COUNT of the ten indicators whose rate met the CMS threshold for the period (max 10). An
// indicator suppressed for LOW N counts as NOT-met (only `thresholdMet === true` scores) — the agency had
// a reportable population and did not meet the criterion in it. An indicator whose input is STRUCTURALLY
// unavailable is different in kind and suppresses the whole composite instead: see `computeHciScore`. The
// composite is "above the national average" when the score ≥ the per-FY cut (D15: ≥ 7/10). This file
// composes the ten per-indicator results — it does NOT re-fetch or recompute them; the worker computes each
// indicator, then hands the ten results here.
import type { QualityMeasureValueResult } from "../result";
import { isDataUnavailable, ratioResult, unavailableResult } from "../result";
import type { HciIndicatorKey, HciThresholdTable } from "./thresholds";

export * from "./availability";
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

/**
 * What the composite reports when an indicator could not contribute — see {@link computeHciScore}.
 *
 * Both arms suppress; they differ in why, and the difference is the whole point. An indicator whose input
 * is structurally unavailable (`HCI_UNAVAILABLE_INDICATORS`) is not one the agency failed to meet, and an
 * indicator whose value has not been computed for the period yet is not one it failed either.
 */
export const HCI_COMPOSITE_INCOMPLETE_REASON =
  "The HCI composite is the count of the ten indicators meeting their CMS threshold, so a partial composite is not a lower score — it is a different measure. It is withheld until all ten contribute.";

/** The HCI score above which the composite is banded yellow rather than red (mid-band floor). */
export const HCI_MID_BAND_SCORE = 5;

/**
 * The ten per-indicator results, keyed by indicator (the worker computes each, then composes here).
 *
 * A value may be `null`: the ten indicators are ten INDEPENDENT recompute jobs, so on the first nightly
 * pass for a period the composite can be resolved before some of its inputs exist. That is a suppressed
 * composite for one night, not an error — the next pass finds the rows. It is spelled out in the type
 * because `Record<K, V>` would have made the absent case a lie the compiler agreed with.
 */
export type HciIndicatorResults = Readonly<
  Record<HciIndicatorKey, QualityMeasureValueResult | null>
>;

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
 *
 * This is an approximation of CMS's real composite, not a reproduction of it — see the threshold-table
 * note in `./thresholds.ts` for why (national-percentile scoring, not fixed cuts).
 */
export function computeHciScore(input: HciCompositeInput): QualityMeasureValueResult {
  const perIndicator: Record<string, boolean | null> = {};
  const unavailable: string[] = [];
  const notComputed: string[] = [];
  let metCount = 0;
  for (const key of HCI_INDICATOR_KEYS) {
    const result = input.indicators[key];
    if (result === undefined || result === null) {
      notComputed.push(key);
      perIndicator[key] = null;
      continue;
    }
    if (isDataUnavailable(result)) {
      unavailable.push(key);
      perIndicator[key] = null;
      continue;
    }
    const met = result.thresholdMet;
    perIndicator[key] = met;
    if (met === true) metCount += 1;
  }

  // A partial composite must not be published. `metCount` out of ten is only meaningful when all ten
  // indicators actually reported: an indicator that could not be computed contributes a zero to the count
  // exactly like an indicator the agency MISSED, so scoring anyway publishes "7/10" for an agency whose
  // real answer is unknown — and 7 is the D15 above-average cut, so the fabrication lands precisely on the
  // boundary the number exists to sit on. Three indicators (5/6/7) are structurally unavailable to any
  // provider-side system, so on this platform this arm is the normal outcome, not an edge case.
  if (unavailable.length > 0 || notComputed.length > 0) {
    return unavailableResult({
      threshold: {
        value: input.thresholds.compositeAboveAverageScore / HCI_INDICATOR_KEYS.length,
        direction: "gte",
        label: "HCI composite above the national average",
      },
      unavailable: {
        reason: HCI_COMPOSITE_INCOMPLETE_REASON,
        requires:
          unavailable.length > 0
            ? `an input source for ${unavailable.join(", ")} (see HCI_UNAVAILABLE_INDICATORS)`
            : `a computed value for ${notComputed.join(", ")} in this period`,
      },
      snapshot: {
        indicator: "hci_composite",
        fiscalYear: input.thresholds.fiscalYear,
        maxScore: HCI_INDICATOR_KEYS.length,
        aboveAverageCut: input.thresholds.compositeAboveAverageScore,
        contributingIndicators: HCI_INDICATOR_KEYS.length - unavailable.length - notComputed.length,
        unavailableIndicators: unavailable,
        notYetComputedIndicators: notComputed,
        perIndicatorThresholdMet: perIndicator,
      },
    });
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

  // The composite bands on a COUNT (indicators met, out of ten) rather than on a rate, so `ratioResult`
  // was given no `ThresholdRule` and left `thresholdValue` null. Restate the cut on the same scale as
  // `rate` (`metCount / 10`) — without it a red composite would be a band with no stated threshold, which
  // the breach path (correctly) refuses to emit an alert for.
  return {
    ...base,
    thresholdMet: metCount >= aboveAverageCut,
    thresholdValue: aboveAverageCut / HCI_INDICATOR_KEYS.length,
    bandColor,
  };
}
