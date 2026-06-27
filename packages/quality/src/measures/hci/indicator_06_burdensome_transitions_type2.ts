// @wardenx/quality — HCI indicator 6: Burdensome Transitions Type 2 (§1.1). Pure. No IO.
//
// CMS criterion: the rate of type-2 burdensome care transitions (live discharge → hospitalization → death
// in hospital, no hospice readmission) is LOW (lower is better). Numerator = decedents with a type-2
// burdensome transition; denominator = decedents. Source: M6 `DischargeReader` + M23 `ClaimLineReader`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched transition counts for HCI indicator 6. */
export interface HciIndicator06Input extends ComputeMeasureInput {
  /** Decedents evaluated for burdensome transitions (denominator). */
  readonly totalDecedents: number;
  /** Decedents with a type-2 burdensome transition (numerator). */
  readonly type2BurdensomeTransitions: number;
  /** The per-FY threshold (`indicator_06`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 6 (burdensome transitions, type 2). Pure. */
export function computeHciIndicator06(input: HciIndicator06Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.type2BurdensomeTransitions,
    denominator: input.totalDecedents,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_06",
      totalDecedents: input.totalDecedents,
      type2BurdensomeTransitions: input.type2BurdensomeTransitions,
    },
  });
}
