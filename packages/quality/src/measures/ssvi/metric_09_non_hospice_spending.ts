// @wardenx/quality — SSVI metric 9: Total non-hospice spending, scored 0-8 by octile of hospices
// (CMS-1851-F Table 9). Pure. No IO.
//
// Medicare Part A/B/D amounts paid to OTHER providers on hospice election days (excluding admission and
// live-discharge days). $0 scores 0; above zero, the octile band (each band's lower bound exclusive) scores 1-8.
// Structurally unavailable to a provider-side EHR (see `SSVI_UNAVAILABLE_METRICS`): the worker passes
// `unavailable` and the calculator suppresses with the reason. The scoring path stays implemented and tested so
// a future claims feed only has to delete the availability entry.
//
// Result shape: numerator = the points (0-8), denominator = 8, rate = points / 8. Not threshold-evaluated on its
// own (CMS scores it only into the total), so `thresholdMet` is null; the band is red in the top octile.
import type {
  ComputeMeasureInput,
  MeasureUnavailability,
  QualityMeasureValueResult,
} from "../result";
import { unavailableResult } from "../result";
import { SSVI_POINTS_SNAPSHOT_KEY } from "./point_result";
import { ssviSpendingPoints } from "./thresholds";

/** Already-fetched spending for SSVI metric 9. */
export interface SsviMetric09Input extends ComputeMeasureInput {
  /** Total non-hospice Medicare spending for the hospice's beneficiaries, whole cents. */
  readonly nonHospiceSpendingCents: number;
  /** The octile UPPER bounds in cents (`SsviThresholdTable.spendingOctileUpperBoundsCents`). */
  readonly octileUpperBoundsCents: readonly number[];
  /** Set when the input is structurally unavailable — the calculator then suppresses with the reason. */
  readonly unavailable?: MeasureUnavailability;
}

/** Compute SSVI metric 9 (non-hospice spending octile points). Pure. */
export function computeSsviMetric09(input: SsviMetric09Input): QualityMeasureValueResult {
  if (input.unavailable !== undefined) {
    return unavailableResult({
      unavailable: input.unavailable,
      snapshot: { indicator: "ssvi_metric_09", internalEstimate: true },
    });
  }
  const maxPoints = input.octileUpperBoundsCents.length + 1;
  const points = ssviSpendingPoints(input.nonHospiceSpendingCents, input.octileUpperBoundsCents);
  return {
    numerator: points,
    denominator: maxPoints,
    rate: points / maxPoints,
    thresholdMet: null,
    thresholdValue: null,
    bandColor: points === maxPoints ? "red" : "green",
    computationSnapshot: {
      indicator: "ssvi_metric_09",
      internalEstimate: true,
      nonHospiceSpendingCents: input.nonHospiceSpendingCents,
      octileUpperBoundsCents: [...input.octileUpperBoundsCents],
      [SSVI_POINTS_SNAPSHOT_KEY]: points,
    },
  };
}
