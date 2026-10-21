// @chartwarden/quality — operational measure: PRN effectiveness documented rate. Pure. No IO.
// Rate of PRN administrations with a follow-up effectiveness assessment documented (higher is better).
// Source: M13 `MedicationAdministrationProvider.getPrnEffectivenessRate`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched PRN-effectiveness counts. */
export interface PrnEffectivenessDocumentedRateInput extends ComputeMeasureInput {
  /** PRN administrations in the window (denominator). */
  readonly prnAdministrations: number;
  /** PRN administrations with a documented effectiveness assessment (numerator). */
  readonly prnWithEffectivenessDocumented: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the PRN-effectiveness-documented rate. Pure. */
export function computePrnEffectivenessDocumentedRate(
  input: PrnEffectivenessDocumentedRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.prnWithEffectivenessDocumented,
    denominator: input.prnAdministrations,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "prn_effectiveness_documented_rate",
      prnAdministrations: input.prnAdministrations,
      prnWithEffectivenessDocumented: input.prnWithEffectivenessDocumented,
    },
  });
}
