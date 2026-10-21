// @chartwarden/quality — HCI indicator 6: Burdensome Transitions Type 2 (§1.1). Pure. No IO.
//
// CMS criterion: the rate of type-2 burdensome care transitions (live discharge → hospitalization → death
// in hospital, no hospice readmission) is LOW (lower is better). Numerator = decedents with a type-2
// burdensome transition; denominator = decedents. Source: M6 `DischargeReader` + M23 `ClaimLineReader`.
import type {
  ComputeMeasureInput,
  MeasureUnavailability,
  QualityMeasureValueResult,
  ThresholdRule,
} from "../result";
import { ratioResult, unavailableResult } from "../result";

/** Already-fetched transition counts for HCI indicator 6. */
export interface HciIndicator06Input extends ComputeMeasureInput {
  /** Decedents evaluated for burdensome transitions (denominator). */
  readonly totalDecedents: number;
  /** Decedents with a type-2 burdensome transition (numerator). */
  readonly type2BurdensomeTransitions: number;
  /**
   * Set when this indicator's input is STRUCTURALLY unavailable (`HCI_UNAVAILABLE_INDICATORS`) —
   * the calculator then suppresses with the reason instead of scoring 0/0, which would read as
   * "low N" on the dashboard and count as a missed indicator in the composite. Absent for a
   * deployment that can assemble the population.
   */
  readonly unavailable?: MeasureUnavailability;
  /** The per-FY threshold (`indicator_06`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 6 (burdensome transitions, type 2). Pure. */
export function computeHciIndicator06(input: HciIndicator06Input): QualityMeasureValueResult {
  if (input.unavailable !== undefined) {
    return unavailableResult({
      unavailable: input.unavailable,
      threshold: input.threshold,
      snapshot: { indicator: "hci_indicator_06" },
    });
  }
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
