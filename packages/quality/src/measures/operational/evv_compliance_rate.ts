// @wardenx/quality — operational measure: EVV compliance rate (Cures Act §12006). Pure. No IO.
// Rate of EVV-required visits with a verified electronic visit record (higher is better). Source: M18
// `EvvMetricsProvider.getComplianceRate`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched EVV compliance counts. */
export interface EvvComplianceRateInput extends ComputeMeasureInput {
  /** Visits requiring EVV verification in the window (denominator). */
  readonly evvRequiredVisits: number;
  /** EVV-required visits with a verified electronic record (numerator). */
  readonly evvVerifiedVisits: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the EVV-compliance rate. Pure. */
export function computeEvvComplianceRate(input: EvvComplianceRateInput): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.evvVerifiedVisits,
    denominator: input.evvRequiredVisits,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "evv_compliance_rate",
      evvRequiredVisits: input.evvRequiredVisits,
      evvVerifiedVisits: input.evvVerifiedVisits,
    },
  });
}
