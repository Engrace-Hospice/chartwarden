// @chartwarden/quality — operational measure: supervisory visit on time (CoP 418.76). Pure. No IO.
// Rate of required aide-supervisory visits performed within the regulatory window (higher is better).
// Source: M15 `DisciplineComplianceProvider`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched supervisory-visit timeliness counts. */
export interface SupervisoryVisitOnTimeInput extends ComputeMeasureInput {
  /** Required supervisory visits in the window (denominator). */
  readonly requiredSupervisoryVisits: number;
  /** Supervisory visits performed within the window (numerator). */
  readonly supervisoryVisitsOnTime: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the supervisory-visit-on-time rate. Pure. */
export function computeSupervisoryVisitOnTime(
  input: SupervisoryVisitOnTimeInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.supervisoryVisitsOnTime,
    denominator: input.requiredSupervisoryVisits,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "supervisory_visit_on_time",
      requiredSupervisoryVisits: input.requiredSupervisoryVisits,
      supervisoryVisitsOnTime: input.supervisoryVisitsOnTime,
    },
  });
}
