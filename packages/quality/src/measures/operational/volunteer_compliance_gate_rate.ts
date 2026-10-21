// @chartwarden/quality — operational measure: volunteer compliance gate rate (CoP 418.78). Pure. No IO.
// Rate of reporting periods where the 5%-volunteer-cost-savings gate was met (higher is better). Source:
// M15 `DisciplineComplianceProvider` (volunteer gate).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched volunteer-gate counts. */
export interface VolunteerComplianceGateRateInput extends ComputeMeasureInput {
  /** Reporting sub-periods evaluated for the volunteer gate (denominator). */
  readonly evaluatedPeriods: number;
  /** Sub-periods meeting the volunteer compliance gate (numerator). */
  readonly periodsMeetingGate: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the volunteer-compliance-gate rate. Pure. */
export function computeVolunteerComplianceGateRate(
  input: VolunteerComplianceGateRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.periodsMeetingGate,
    denominator: input.evaluatedPeriods,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "volunteer_compliance_gate_rate",
      evaluatedPeriods: input.evaluatedPeriods,
      periodsMeetingGate: input.periodsMeetingGate,
    },
  });
}
