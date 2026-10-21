// @chartwarden/quality — HCI indicator 9: Skilled Nursing Minutes on Weekends (§1.1). Pure. No IO.
//
// CMS definition: the SHARE of skilled-nursing minutes (on RHC days) delivered on a Saturday or Sunday —
// weekend SN minutes ÷ all SN minutes. Higher is better. Numerator = SN (RN/LPN) minutes on weekend RHC
// days; denominator = SN minutes on all RHC days. Source: M6 `LevelOfCarePeriodReader` × M8
// `SignedEncountersReader.skilledNursingDayTotalsForOrg`, reduced by `skilledNursingMinutesOnRhcDays`.
// A period with no skilled-nursing minutes on RHC days has no share to report and is `insufficient_n`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched skilled-nursing minute totals for HCI indicator 9. */
export interface HciIndicator09Input extends ComputeMeasureInput {
  /** Skilled-nursing minutes delivered on RHC days in the window (denominator). */
  readonly totalSkilledNursingMinutes: number;
  /** Of those, the minutes delivered on a Saturday or Sunday (numerator). */
  readonly weekendSkilledNursingMinutes: number;
  /** The per-FY threshold (`indicator_09`; higher-is-better, a share in [0, 1]). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 9 (share of skilled-nursing minutes delivered on weekends). Pure. */
export function computeHciIndicator09(input: HciIndicator09Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.weekendSkilledNursingMinutes,
    denominator: input.totalSkilledNursingMinutes,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_09",
      totalSkilledNursingMinutes: input.totalSkilledNursingMinutes,
      weekendSkilledNursingMinutes: input.weekendSkilledNursingMinutes,
    },
  });
}
