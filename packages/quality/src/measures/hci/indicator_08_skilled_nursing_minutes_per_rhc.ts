// @wardenx/quality — HCI indicator 8: Skilled Nursing Care Minutes per Routine Home Care (RHC) day
// (§1.1). Pure. No IO.
//
// CMS definition: the MEAN skilled-nursing minutes per RHC day — total skilled-nursing (RN/LPN) minutes
// delivered on RHC days ÷ total RHC days. Higher is better. Source: M6 `LevelOfCarePeriodReader` (RHC day
// spans) × M8 `SignedEncountersReader.skilledNursingDayTotalsForOrg` (per-day SN minutes), reduced by
// `skilledNursingMinutesOnRhcDays`.
//
// RESULT SHAPE — this is the one computed measure whose CMS value is not a proportion, and the result
// contract (`QualityMeasureValueResult.rate` ∈ [0, 1], persisted in `quality_measure_value.ratio`
// numeric(6,4) and rendered as a percentage) is built for proportions. So:
//   - `numerator` / `denominator` are CMS's own: SN minutes on RHC days / RHC days. The mean is exactly
//     `numerator / denominator`, and is also carried in the snapshot (`meanSkilledNursingMinutesPerRhcDay`).
//   - the threshold rule is stated in CMS's unit (minutes per RHC day), and `thresholdMet` / the band /
//     the small-N floor are all decided on the mean by `ratioResult` — the composite scores on those.
//   - `rate` (and `thresholdValue`, which must share its scale for the breach event) is that mean
//     expressed as a proportion of the day: mean ÷ 1440, i.e. the share of RHC-day minutes delivered as
//     skilled nursing. A linear rescale — same ordering, same verdict — that stays in [0, 1] and inside
//     the ratio column's precision (a raw mean of 100+ minutes would overflow numeric(6,4)).
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Minutes in a calendar day — the scale `rate` is expressed on for indicator 8 (see the file header). */
export const HCI_MINUTES_PER_DAY = 1440;

/** Already-fetched RHC-day / skilled-nursing-minute totals for HCI indicator 8. */
export interface HciIndicator08Input extends ComputeMeasureInput {
  /** Routine-home-care days in the window (denominator). */
  readonly totalRhcDays: number;
  /** Skilled-nursing minutes delivered on those RHC days (numerator). */
  readonly skilledNursingMinutesOnRhcDays: number;
  /** The per-FY threshold (`indicator_08`; higher-is-better, in MINUTES per RHC day). */
  readonly threshold: ThresholdRule;
}

/** Compute HCI indicator 8 (mean skilled-nursing minutes per RHC day). Pure. */
export function computeHciIndicator08(input: HciIndicator08Input): QualityMeasureValueResult {
  const base = ratioResult({
    numerator: input.skilledNursingMinutesOnRhcDays,
    denominator: input.totalRhcDays,
    threshold: input.threshold,
    snapshot: {
      indicator: "hci_indicator_08",
      totalRhcDays: input.totalRhcDays,
      skilledNursingMinutesOnRhcDays: input.skilledNursingMinutesOnRhcDays,
      thresholdMinutesPerRhcDay: input.threshold.value,
      rateScale: "share of RHC-day minutes (mean SN minutes per RHC day / 1440)",
    },
  });
  // `base.rate` is the CMS mean in minutes (numerator / denominator), or null when suppressed.
  const mean = base.rate;
  return {
    ...base,
    rate: mean === null ? null : mean / HCI_MINUTES_PER_DAY,
    thresholdValue: base.thresholdValue === null ? null : base.thresholdValue / HCI_MINUTES_PER_DAY,
    computationSnapshot: { ...base.computationSnapshot, meanSkilledNursingMinutesPerRhcDay: mean },
  };
}
