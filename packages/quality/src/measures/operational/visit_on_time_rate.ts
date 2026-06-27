// @wardenx/quality — operational measure: visit on-time rate. Pure. No IO.
// Rate of scheduled visits performed within the on-time window (higher is better). Source: M17
// `VisitMetricsProvider.getVisitOnTimeRate`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched visit-timeliness counts. */
export interface VisitOnTimeRateInput extends ComputeMeasureInput {
  /** Scheduled visits in the window (denominator). */
  readonly scheduledVisits: number;
  /** Scheduled visits performed within the on-time window (numerator). */
  readonly onTimeVisits: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the visit-on-time rate. Pure. */
export function computeVisitOnTimeRate(input: VisitOnTimeRateInput): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.onTimeVisits,
    denominator: input.scheduledVisits,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "visit_on_time_rate",
      scheduledVisits: input.scheduledVisits,
      onTimeVisits: input.onTimeVisits,
    },
  });
}
