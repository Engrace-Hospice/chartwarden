// @chartwarden/quality — operational/HQRP measure: HOPE Symptom Follow-Up Visit (SFV) on-time rate. Pure.
// No IO. Rate of due SFVs completed within the 2-calendar-day window (higher is better). This is the
// operational upstream of the FY2028 TFP-PI / TFP-NPSI measures (§1.1). Source: M10 `HopeJ2051Provider`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched SFV-timeliness counts. */
export interface HopeSfvOnTimeRateInput extends ComputeMeasureInput {
  /** SFVs due in the window (denominator). */
  readonly sfvDue: number;
  /** SFVs completed within the 2-calendar-day window (numerator). */
  readonly sfvOnTime: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the HOPE-SFV-on-time rate. Pure. */
export function computeHopeSfvOnTimeRate(input: HopeSfvOnTimeRateInput): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.sfvOnTime,
    denominator: input.sfvDue,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "hope_sfv_on_time_rate",
      sfvDue: input.sfvDue,
      sfvOnTime: input.sfvOnTime,
    },
  });
}
