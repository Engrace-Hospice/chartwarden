// @wardenx/quality — operational measure: opioid-on-admission rate. Pure. No IO.
// Rate of admissions with an active opioid order at admission. This is an INFORMATIONAL surveillance
// measure (neither inherently good nor bad); the threshold/direction is supplied by the caller so the
// banding reflects the agency's tracked target. Source: M12 `getOpioidOnAdmissionStats`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched opioid-on-admission counts. */
export interface OpioidOnAdmissionRateInput extends ComputeMeasureInput {
  /** Admissions in the window (denominator). */
  readonly admissions: number;
  /** Admissions with an active opioid order at admission (numerator). */
  readonly admissionsWithOpioid: number;
  /** The agency-tracked target (direction supplied by the caller — informational measure). */
  readonly threshold: ThresholdRule;
  /** Optional warn band. */
  readonly warn?: ThresholdRule;
}

/** Compute the opioid-on-admission rate. Pure. */
export function computeOpioidOnAdmissionRate(
  input: OpioidOnAdmissionRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.admissionsWithOpioid,
    denominator: input.admissions,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "opioid_on_admission_rate",
      admissions: input.admissions,
      admissionsWithOpioid: input.admissionsWithOpioid,
    },
  });
}
