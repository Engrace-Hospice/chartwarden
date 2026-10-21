// @chartwarden/quality — HCI indicator 2: Gaps in Skilled Nursing visits (§1.1). Pure. No IO.
//
// CMS criterion: the proportion of elections with a skilled-nursing visit gap exceeding the CMS-defined
// interval is LOW (lower is better). Numerator = elections with ≥ 1 qualifying SN gap; denominator =
// elections. Source: M8 `EncounterStatisticsProvider` discipline-visit cadence.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched skilled-nursing cadence counts for HCI indicator 2. */
export interface HciIndicator02Input extends ComputeMeasureInput {
  /** Election periods evaluated for SN-visit gaps (denominator). */
  readonly totalElectionPeriods: number;
  /** Election periods with at least one SN-visit gap beyond the CMS interval (numerator). */
  readonly periodsWithSkilledNursingGap: number;
  /** The per-FY threshold (`indicator_02`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 2 (gaps in skilled nursing). Pure. */
export function computeHciIndicator02(input: HciIndicator02Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.periodsWithSkilledNursingGap,
    denominator: input.totalElectionPeriods,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_02",
      totalElectionPeriods: input.totalElectionPeriods,
      periodsWithSkilledNursingGap: input.periodsWithSkilledNursingGap,
    },
  });
}
