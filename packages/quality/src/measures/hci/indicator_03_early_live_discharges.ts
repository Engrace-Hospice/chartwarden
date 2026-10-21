// @chartwarden/quality — HCI indicator 3: Early Live Discharges (§1.1). Pure. No IO.
//
// CMS criterion: the rate of LIVE discharges occurring early in the stay is LOW (lower is better).
// Numerator = early live discharges; denominator = all discharges. Source: M6 `DischargeReader`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched discharge counts for HCI indicator 3. */
export interface HciIndicator03Input extends ComputeMeasureInput {
  /** All discharges (live + death) in the window (denominator). */
  readonly totalDischarges: number;
  /** Live discharges flagged "early" by the CMS day-threshold (numerator). */
  readonly earlyLiveDischarges: number;
  /** The per-FY threshold (`indicator_03`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 3 (early live discharges). Pure. */
export function computeHciIndicator03(input: HciIndicator03Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.earlyLiveDischarges,
    denominator: input.totalDischarges,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_03",
      totalDischarges: input.totalDischarges,
      earlyLiveDischarges: input.earlyLiveDischarges,
    },
  });
}
