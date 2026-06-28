// @wardenx/quality — HOPE-derived measure: Timely Follow-Up for Non-Pain Symptom Impact (TFP-NPSI)
// (§1.1, D4). Pure, IO-free. CMS HQRP-active FY2028; runs today against M10 `HopeJ2051Provider` data.
//
// TFP-NPSI = % of HOPE J2051 NON-PAIN symptom-impact triggers (impact moderate-or-severe) where a Symptom
// Follow-Up Visit was completed within the 2-calendar-day window (M10 D4 / M30-F04). Denominator =
// qualifying non-pain-impact triggers; numerator = those with an in-window SFV.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";
import { TFP_FOLLOW_UP_WINDOW_DAYS } from "./timely_followup_pain";

/** Already-fetched HOPE J2051 non-pain-impact counts for TFP-NPSI. */
export interface TimelyFollowUpNonPainInput extends ComputeMeasureInput {
  /** J2051 non-pain symptom-impact triggers with moderate-or-severe impact (denominator). */
  readonly qualifyingNonPainImpactTriggers: number;
  /** Of those, the count with an SFV completed within {@link TFP_FOLLOW_UP_WINDOW_DAYS} (numerator). */
  readonly followUpVisitsWithinWindow: number;
  /** The per-FY threshold (higher-is-better — more timely follow-ups). */
  readonly threshold: ThresholdRule;
}

/** Compute TFP-NPSI (timely follow-up for non-pain symptom impact). Pure. */
export function computeTimelyFollowUpNonPain(
  input: TimelyFollowUpNonPainInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.followUpVisitsWithinWindow,
    denominator: input.qualifyingNonPainImpactTriggers,
    threshold: input.threshold,
    snapshot: {
      measure: "tfp_npsi",
      followUpWindowDays: TFP_FOLLOW_UP_WINDOW_DAYS,
      qualifyingNonPainImpactTriggers: input.qualifyingNonPainImpactTriggers,
      followUpVisitsWithinWindow: input.followUpVisitsWithinWindow,
    },
  });
}
