// @wardenx/quality — HCI indicator 5: Burdensome Transitions Type 1 (§1.1). Pure. No IO.
//
// CMS criterion: the rate of type-1 burdensome care transitions (live discharge → hospitalization →
// hospice readmission pattern) is LOW (lower is better). Numerator = decedents with a type-1 burdensome
// transition; denominator = decedents. Source: M6 `DischargeReader` + M23 `ClaimLineReader`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched transition counts for HCI indicator 5. */
export interface HciIndicator05Input extends ComputeMeasureInput {
  /** Decedents evaluated for burdensome transitions (denominator). */
  readonly totalDecedents: number;
  /** Decedents with a type-1 burdensome transition (numerator). */
  readonly type1BurdensomeTransitions: number;
  /** The per-FY threshold (`indicator_05`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 5 (burdensome transitions, type 1). Pure. */
export function computeHciIndicator05(input: HciIndicator05Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.type1BurdensomeTransitions,
    denominator: input.totalDecedents,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_05",
      totalDecedents: input.totalDecedents,
      type1BurdensomeTransitions: input.type1BurdensomeTransitions,
    },
  });
}
