// @wardenx/quality — HCI indicator 8: Skilled Nursing Care Minutes per Routine Home Care (RHC) day
// (§1.1). Pure. No IO.
//
// CMS criterion: RHC days delivering skilled-nursing minutes at/above the CMS per-day floor is HIGH
// (higher is better). Numerator = RHC days meeting the SN-minutes floor; denominator = RHC days. Source:
// M8 `EncounterStatisticsProvider` (SN minutes) + M6 `LevelOfCarePeriodReader` (RHC days).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched RHC/SN-minute counts for HCI indicator 8. */
export interface HciIndicator08Input extends ComputeMeasureInput {
  /** Routine-home-care days in the window (denominator). */
  readonly totalRhcDays: number;
  /** RHC days delivering SN minutes at/above the CMS per-day floor (numerator). */
  readonly rhcDaysMeetingSnMinuteFloor: number;
  /** The per-FY threshold (`indicator_08`; higher-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 8 (skilled-nursing minutes per RHC day). Pure. */
export function computeHciIndicator08(input: HciIndicator08Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.rhcDaysMeetingSnMinuteFloor,
    denominator: input.totalRhcDays,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_08",
      totalRhcDays: input.totalRhcDays,
      rhcDaysMeetingSnMinuteFloor: input.rhcDaysMeetingSnMinuteFloor,
    },
  });
}
