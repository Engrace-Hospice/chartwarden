// @wardenx/quality — HCI indicator 9: Skilled Nursing Minutes on Weekends (§1.1). Pure. No IO.
//
// CMS criterion: weekend days delivering skilled-nursing minutes at/above the CMS floor is HIGH (higher is
// better). Numerator = weekend care-days meeting the SN-minutes floor; denominator = weekend care-days.
// Source: M8 `EncounterStatisticsProvider` (SN minutes, weekend filter).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched weekend SN-minute counts for HCI indicator 9. */
export interface HciIndicator09Input extends ComputeMeasureInput {
  /** Weekend care-days in the window (denominator). */
  readonly totalWeekendCareDays: number;
  /** Weekend care-days delivering SN minutes at/above the CMS floor (numerator). */
  readonly weekendDaysMeetingSnMinuteFloor: number;
  /** The per-FY threshold (`indicator_09`; higher-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 9 (skilled-nursing minutes on weekends). Pure. */
export function computeHciIndicator09(input: HciIndicator09Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.weekendDaysMeetingSnMinuteFloor,
    denominator: input.totalWeekendCareDays,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_09",
      totalWeekendCareDays: input.totalWeekendCareDays,
      weekendDaysMeetingSnMinuteFloor: input.weekendDaysMeetingSnMinuteFloor,
    },
  });
}
