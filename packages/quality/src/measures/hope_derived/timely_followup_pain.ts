// @chartwarden/quality — HOPE-derived measure: Timely Follow-Up for Pain Impact (TFP-PI) (§1.1, D4).
// Pure, IO-free. CMS HQRP-active FY2028; the calculator runs today against M10 `HopeJ2051Provider` data.
//
// TFP-PI = % of HOPE J2051 PAIN-impact triggers (impact moderate-or-severe) where a Symptom Follow-Up
// Visit (SFV) was completed within the 2-calendar-day window (M10 D4 / M30-F04 SFV-clock semantics).
// Denominator = qualifying pain-impact triggers; numerator = those with an in-window SFV.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** The CMS SFV follow-up window in calendar days (M10 D4 / M30-F04). */
export const TFP_FOLLOW_UP_WINDOW_DAYS = 2;

/** Already-fetched HOPE J2051 pain-impact counts for TFP-PI. */
export interface TimelyFollowUpPainInput extends ComputeMeasureInput {
  /** J2051 pain-impact triggers with moderate-or-severe impact in the period (denominator). */
  readonly qualifyingPainImpactTriggers: number;
  /** Of those, the count with an SFV completed within {@link TFP_FOLLOW_UP_WINDOW_DAYS} (numerator). */
  readonly followUpVisitsWithinWindow: number;
  /** The per-FY threshold (higher-is-better — more timely follow-ups). */
  readonly threshold: ThresholdRule;
}

/** Compute TFP-PI (timely follow-up for pain impact). Pure. */
export function computeTimelyFollowUpPain(
  input: TimelyFollowUpPainInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.followUpVisitsWithinWindow,
    denominator: input.qualifyingPainImpactTriggers,
    threshold: input.threshold,
    snapshot: {
      measure: "tfp_pi",
      followUpWindowDays: TFP_FOLLOW_UP_WINDOW_DAYS,
      qualifyingPainImpactTriggers: input.qualifyingPainImpactTriggers,
      followUpVisitsWithinWindow: input.followUpVisitsWithinWindow,
    },
  });
}
