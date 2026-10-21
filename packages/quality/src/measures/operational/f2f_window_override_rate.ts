// @chartwarden/quality — operational measure: F2F compliance-window override rate (CoP 418.22). Pure. No IO.
// Rate of F2F compliance windows closed via a documented Medical-Director override rather than a plain
// on-time attestation — the escape-valve usage rate (LOWER is better: overrides should be rare, not
// routine). Same population/denominator as `f2f_window_on_time_rate` (§7.5 W-OVR-02: the two are tracked
// as separate signals — "Overrides count" vs. on-time rate — not folded together). Source: M6
// `ComplianceWindowCountsProvider.f2fWindowOverrideCounts` (F-178, #248).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched F2F window override-close counts. */
export interface F2fWindowOverrideRateInput extends ComputeMeasureInput {
  /** F2F compliance windows due to close in the window (denominator; same population as the on-time rate). */
  readonly f2fWindowsDue: number;
  /** F2F windows closed via a documented MD override (numerator). */
  readonly f2fClosedViaOverride: number;
  /** The per-FY/agency target (lower-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band above target. */
  readonly warn?: ThresholdRule;
}

/** Compute the F2F-window override rate. Pure. */
export function computeF2fWindowOverrideRate(
  input: F2fWindowOverrideRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.f2fClosedViaOverride,
    denominator: input.f2fWindowsDue,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "f2f_window_override_rate",
      f2fWindowsDue: input.f2fWindowsDue,
      f2fClosedViaOverride: input.f2fClosedViaOverride,
    },
  });
}
