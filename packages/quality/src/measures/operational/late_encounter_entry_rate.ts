// @wardenx/quality — operational measure: late-encounter-entry rate. Pure. No IO.
// Rate of signed encounters whose documentation was entered after the agency's late-entry threshold
// (LOWER is better). Source: M8 `SignedEncountersReader` (late-entry tiers).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched late-entry counts. */
export interface LateEncounterEntryRateInput extends ComputeMeasureInput {
  /** Signed encounters in the window (denominator). */
  readonly signedEncounters: number;
  /** Signed encounters entered after the late-entry threshold (numerator). */
  readonly lateEntries: number;
  /** The per-FY/agency target (lower-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band above target. */
  readonly warn?: ThresholdRule;
}

/** Compute the late-encounter-entry rate. Pure. */
export function computeLateEncounterEntryRate(
  input: LateEncounterEntryRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.lateEntries,
    denominator: input.signedEncounters,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "late_encounter_entry_rate",
      signedEncounters: input.signedEncounters,
      lateEntries: input.lateEntries,
    },
  });
}
