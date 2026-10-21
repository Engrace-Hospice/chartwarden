// @chartwarden/quality — HCI indicator 5: Burdensome Transitions Type 1 (§1.1). Pure. No IO.
//
// CMS criterion: the rate of type-1 burdensome care transitions (live discharge → hospitalization →
// hospice readmission pattern) is LOW (lower is better). Numerator = decedents with a type-1 burdensome
// transition; denominator = decedents. Source: M6 `DischargeReader` + M23 `ClaimLineReader`.
import type {
  ComputeMeasureInput,
  MeasureUnavailability,
  QualityMeasureValueResult,
  ThresholdRule,
} from "../result";
import { ratioResult, unavailableResult } from "../result";

/** Already-fetched transition counts for HCI indicator 5. */
export interface HciIndicator05Input extends ComputeMeasureInput {
  /** Decedents evaluated for burdensome transitions (denominator). */
  readonly totalDecedents: number;
  /** Decedents with a type-1 burdensome transition (numerator). */
  readonly type1BurdensomeTransitions: number;
  /**
   * Set when this indicator's input is STRUCTURALLY unavailable (`HCI_UNAVAILABLE_INDICATORS`) —
   * the calculator then suppresses with the reason instead of scoring 0/0, which would read as
   * "low N" on the dashboard and count as a missed indicator in the composite. Absent for a
   * deployment that can assemble the population.
   */
  readonly unavailable?: MeasureUnavailability;
  /** The per-FY threshold (`indicator_05`; lower-is-better). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 5 (burdensome transitions, type 1). Pure. */
export function computeHciIndicator05(input: HciIndicator05Input): QualityMeasureValueResult {
  if (input.unavailable !== undefined) {
    return unavailableResult({
      unavailable: input.unavailable,
      threshold: input.threshold,
      snapshot: { indicator: "hci_indicator_05" },
    });
  }
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
