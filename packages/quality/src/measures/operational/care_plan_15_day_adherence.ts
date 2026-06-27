// @wardenx/quality — operational measure: care-plan 15-day adherence (CoP 418.56). Pure. No IO.
// Rate of care plans updated within the required 15-day cycle (higher is better). Source: M7
// `CarePlanComplianceProvider.fifteenDayAdherenceForPatient`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched care-plan 15-day adherence counts. */
export interface CarePlan15DayAdherenceInput extends ComputeMeasureInput {
  /** Care-plan review cycles due in the window (denominator). */
  readonly carePlanCyclesDue: number;
  /** Cycles whose care plan was updated within 15 days (numerator). */
  readonly cyclesUpdatedWithin15Days: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the care-plan-15-day-adherence rate. Pure. */
export function computeCarePlan15DayAdherence(
  input: CarePlan15DayAdherenceInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.cyclesUpdatedWithin15Days,
    denominator: input.carePlanCyclesDue,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "care_plan_15_day_adherence",
      carePlanCyclesDue: input.carePlanCyclesDue,
      cyclesUpdatedWithin15Days: input.cyclesUpdatedWithin15Days,
    },
  });
}
