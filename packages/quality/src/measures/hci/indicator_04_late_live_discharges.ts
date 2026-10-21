// @chartwarden/quality — HCI indicator 4: Late Live Discharges (§1.1). Pure. No IO.
//
// CMS criterion: the rate of LIVE discharges occurring late in the stay is LOW (lower is better).
// Numerator = late live discharges; denominator = all discharges. Source: M6 `DischargeReader`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched discharge counts for HCI indicator 4. */
export interface HciIndicator04Input extends ComputeMeasureInput {
  /** All discharges (live + death) in the window (denominator). */
  readonly totalDischarges: number;
  /** Live discharges flagged "late" by the CMS day-threshold (numerator). */
  readonly lateLiveDischarges: number;
  /** The per-FY threshold (`indicator_04`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 4 (late live discharges). Pure. */
export function computeHciIndicator04(input: HciIndicator04Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.lateLiveDischarges,
    denominator: input.totalDischarges,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_04",
      totalDischarges: input.totalDischarges,
      lateLiveDischarges: input.lateLiveDischarges,
    },
  });
}
