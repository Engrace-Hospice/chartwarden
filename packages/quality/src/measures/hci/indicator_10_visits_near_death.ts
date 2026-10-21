// @chartwarden/quality — HCI indicator 10: Visits Near Death (§1.1). Pure. No IO.
//
// CMS criterion: the proportion of decedents who received visits in the days immediately preceding death
// is HIGH (higher is better). Numerator = decedents with qualifying near-death visits; denominator =
// decedents. Source: M8 `EncounterStatisticsProvider` + M6 `DischargeReader` (death census).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched near-death visit counts for HCI indicator 10. */
export interface HciIndicator10Input extends ComputeMeasureInput {
  /** Decedents in the window (denominator). */
  readonly totalDecedents: number;
  /** Decedents with qualifying visits in the near-death window (numerator). */
  readonly decedentsWithNearDeathVisits: number;
  /** The per-FY threshold (`indicator_10`; higher-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 10 (visits near death). Pure. */
export function computeHciIndicator10(input: HciIndicator10Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.decedentsWithNearDeathVisits,
    denominator: input.totalDecedents,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_10",
      totalDecedents: input.totalDecedents,
      decedentsWithNearDeathVisits: input.decedentsWithNearDeathVisits,
    },
  });
}
