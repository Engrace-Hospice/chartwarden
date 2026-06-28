// @wardenx/quality — operational measure: IDG cadence adherence (CoP 418.56). Pure. No IO.
// Rate of required IDG meetings held within the ≤ 15-day cadence (higher is better). Source: M14
// `IdgScheduleProvider.getCadenceAdherence`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched IDG cadence counts. */
export interface IdgCadenceAdherenceInput extends ComputeMeasureInput {
  /** Required IDG review cycles in the window (denominator). */
  readonly requiredMeetingCycles: number;
  /** Cycles whose meeting occurred within the cadence (numerator). */
  readonly meetingsWithinCadence: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the IDG-cadence-adherence rate. Pure. */
export function computeIdgCadenceAdherence(
  input: IdgCadenceAdherenceInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.meetingsWithinCadence,
    denominator: input.requiredMeetingCycles,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "idg_cadence_adherence",
      requiredMeetingCycles: input.requiredMeetingCycles,
      meetingsWithinCadence: input.meetingsWithinCadence,
    },
  });
}
