// @wardenx/quality — operational measure: bereavement coverage rate (CoP 418.64(d)). Pure. No IO.
// Rate of eligible bereaved caregivers with a bereavement plan in place (higher is better). Source: M16
// `BereavementComplianceProvider`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched bereavement coverage counts. */
export interface BereavementCoverageRateInput extends ComputeMeasureInput {
  /** Eligible bereaved caregivers in the window (denominator). */
  readonly eligibleBereaved: number;
  /** Eligible bereaved with a bereavement plan in place (numerator). */
  readonly bereavedWithPlan: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the bereavement-coverage rate. Pure. */
export function computeBereavementCoverageRate(
  input: BereavementCoverageRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.bereavedWithPlan,
    denominator: input.eligibleBereaved,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "bereavement_coverage_rate",
      eligibleBereaved: input.eligibleBereaved,
      bereavedWithPlan: input.bereavedWithPlan,
    },
  });
}
