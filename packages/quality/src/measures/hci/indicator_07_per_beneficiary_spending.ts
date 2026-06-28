// @wardenx/quality — HCI indicator 7: Per-beneficiary Medicare spending (§1.1). Pure. No IO.
//
// CMS criterion: per-beneficiary Medicare spend is at/below the CMS benchmark (lower is better). Modeled
// as a spend-vs-benchmark RATIO: numerator = total Medicare spend; denominator = benchmark spend for the
// beneficiary-day mix; the rate is the ratio (≤ 1.0 meets). Source: M23 `ClaimLineReader` +
// `PatientDaysProvider`. (Spend dollars are integers in whole-dollar units in the input.)
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched spending figures for HCI indicator 7. */
export interface HciIndicator07Input extends ComputeMeasureInput {
  /** Total Medicare spend attributed to the provider entity in the window (numerator). */
  readonly totalMedicareSpend: number;
  /** The CMS benchmark spend for the same beneficiary-day mix (denominator). */
  readonly benchmarkSpend: number;
  /** The per-FY threshold (`indicator_07`; lower-is-better, cut at the spend÷benchmark ratio). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 7 (per-beneficiary spending). Pure. */
export function computeHciIndicator07(input: HciIndicator07Input): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.totalMedicareSpend,
    denominator: input.benchmarkSpend,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_07",
      totalMedicareSpend: input.totalMedicareSpend,
      benchmarkSpend: input.benchmarkSpend,
    },
  });
}
