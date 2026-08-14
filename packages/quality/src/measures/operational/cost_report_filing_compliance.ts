// @wardenx/quality — operational measure: cost-report filing compliance (CoP 418.310). Pure. No IO.
//
// 42 CFR 418.310 makes failure to file a Medicare cost report grounds for TERMINATION, so this is the
// one CoP indicator with no tolerance band: the share of the org's assessed provider entities that are
// NOT past their filing deadline unfiled, against a 100% floor. Source: M27's
// `CostReportFilingStatusReader` through M30's `QualityCostReportConsumer` forward seam (the quality
// module reads the filing POSTURE only — never worksheet content).
//
// The denominator is `providerEntitiesAssessed`, so an org with no cost report on file at all yields 0/0
// and suppresses (`insufficient_n`) rather than publishing a spurious 100% — an unassessed org is not a
// compliant one, and the same holds when the M27 seam is unavailable (D6 / D13: never substitute a zero).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched cost-report filing posture counts (the M27 forward seam's reduced pair). */
export interface CostReportFilingComplianceInput extends ComputeMeasureInput {
  /** Provider entities whose filing posture was assessed (denominator). */
  readonly providerEntitiesAssessed: number;
  /** Of those, the ones NOT past their filing deadline unfiled (numerator). */
  readonly compliantProviderEntities: number;
  /** The regulatory floor (higher-is-better; 1.0 — 418.310 admits no partial compliance). */
  readonly threshold: ThresholdRule;
}

/** Compute the CoP 418.310 cost-report filing-compliance rate. Pure. */
export function computeCostReportFilingCompliance(
  input: CostReportFilingComplianceInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.compliantProviderEntities,
    denominator: input.providerEntitiesAssessed,
    threshold: input.threshold,
    snapshot: {
      measure: "cost_report_filing_compliance",
      providerEntitiesAssessed: input.providerEntitiesAssessed,
      compliantProviderEntities: input.compliantProviderEntities,
      pastDeadlineUnfiled: input.providerEntitiesAssessed - input.compliantProviderEntities,
    },
  });
}
