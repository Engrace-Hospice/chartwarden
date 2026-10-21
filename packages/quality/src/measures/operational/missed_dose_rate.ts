// @chartwarden/quality — operational measure: missed-dose rate. Pure. No IO.
// Rate of scheduled medication doses recorded as missed (LOWER is better). Source: M13
// `MedicationAdministrationProvider.getMissedDoseRate`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched missed-dose counts. */
export interface MissedDoseRateInput extends ComputeMeasureInput {
  /** Scheduled doses in the window (denominator). */
  readonly scheduledDoses: number;
  /** Scheduled doses recorded as missed (numerator). */
  readonly missedDoses: number;
  /** The per-FY/agency target (lower-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band above target. */
  readonly warn?: ThresholdRule;
}

/** Compute the missed-dose rate. Pure. */
export function computeMissedDoseRate(input: MissedDoseRateInput): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.missedDoses,
    denominator: input.scheduledDoses,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "missed_dose_rate",
      scheduledDoses: input.scheduledDoses,
      missedDoses: input.missedDoses,
    },
  });
}
