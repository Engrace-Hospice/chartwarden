// @wardenx/quality — HCI indicator 1: Continuous Home Care (CHC) or General Inpatient (GIP) provided
// (§1.1). Pure function over already-fetched M6 `LevelOfCarePeriodReader` projections. No IO.
//
// CMS criterion: the hospice provided at least one day of CHC or GIP level of care in the reporting period
// (higher is better). Numerator = election periods with ≥ 1 CHC/GIP day; denominator = election periods.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched level-of-care counts for HCI indicator 1. */
export interface HciIndicator01Input extends ComputeMeasureInput {
  /** Election periods active in the window (denominator). */
  readonly totalElectionPeriods: number;
  /** Election periods with at least one CHC or GIP day (numerator). */
  readonly periodsWithChcOrGipDay: number;
  /** The per-FY threshold ({@link HCI_THRESHOLDS_v2025}.indicators.indicator_01). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 1 (CHC-or-GIP-provided). Pure. */
export function computeHciIndicator01(input: HciIndicator01Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.periodsWithChcOrGipDay,
    denominator: input.totalElectionPeriods,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_01",
      totalElectionPeriods: input.totalElectionPeriods,
      periodsWithChcOrGipDay: input.periodsWithChcOrGipDay,
    },
  });
}
