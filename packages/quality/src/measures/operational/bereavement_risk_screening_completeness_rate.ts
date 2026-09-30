// @wardenx/quality — operational measure: bereavement risk-screening completeness rate. Pure. No IO.
// Rate of bereaved contacts owed a risk screen whose latest risk-score assessment carries USABLE
// evidence — not `minimal` data completeness (higher is better). Source: M16
// `BereavementComplianceProvider.riskScreeningCompletenessCounts` (D17, F-184, #248).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched bereavement risk-screening completeness counts. */
export interface BereavementRiskScreeningCompletenessRateInput extends ComputeMeasureInput {
  /** Active bereaved contacts owed a risk screen in the window (denominator). D17 EXCLUDES contacts
   *  whose latest assessment's data completeness is `minimal` — evidence nobody could have gathered
   *  (e.g. an external-source death) — from this count, not just from the numerator. */
  readonly screeningsDue: number;
  /** Owed contacts whose latest risk-score assessment is complete (numerator). */
  readonly screeningsCompleted: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the bereavement risk-screening completeness rate. Pure. */
export function computeBereavementRiskScreeningCompletenessRate(
  input: BereavementRiskScreeningCompletenessRateInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.screeningsCompleted,
    denominator: input.screeningsDue,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "bereavement_risk_screening_completeness_rate",
      screeningsDue: input.screeningsDue,
      screeningsCompleted: input.screeningsCompleted,
    },
  });
}
