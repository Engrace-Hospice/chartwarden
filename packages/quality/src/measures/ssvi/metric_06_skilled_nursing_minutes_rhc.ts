// @wardenx/quality — SSVI metric 6: Average skilled nursing minutes on RHC (CMS-1851-F Table 9). Pure. No IO.
//
// Point at ≤ 9.8 minutes per RHC day (25th pct). The CMS value is the MEAN skilled-nursing (RN/LPN) minutes per
// routine-home-care day — the same quantity as HCI indicator 8, from the same sources (M6 level-of-care spans ×
// M8 per-day skilled-nursing minutes, reduced by `skilledNursingMinutesOnRhcDays`). The rule is decided on the
// mean in minutes; the stored `rate` / `thresholdValue` are then rescaled to a share of the day (÷ 1440) exactly
// as HCI 8 does, so the proportion contract and the ratio column's precision hold (see HCI 8's file header).
import { HCI_MINUTES_PER_DAY } from "../hci/indicator_08_skilled_nursing_minutes_per_rhc";
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ssviBinaryMetricResult } from "./point_result";
import type { SsviPointRule } from "./thresholds";

/** Already-fetched RHC-day / skilled-nursing-minute totals for SSVI metric 6. */
export interface SsviMetric06Input extends ComputeMeasureInput {
  /** Routine-home-care days in the window (denominator). */
  readonly totalRhcDays: number;
  /** Skilled-nursing minutes delivered on those RHC days (numerator). */
  readonly skilledNursingMinutesOnRhcDays: number;
  /** The point rule, in MINUTES per RHC day (`metric_06`). */
  readonly rule: SsviPointRule;
}

/** Compute SSVI metric 6 (mean skilled-nursing minutes per RHC day). Pure. */
export function computeSsviMetric06(input: SsviMetric06Input): QualityMeasureValueResult {
  const base = ssviBinaryMetricResult({
    metric: "ssvi_metric_06",
    numerator: input.skilledNursingMinutesOnRhcDays,
    denominator: input.totalRhcDays,
    rule: input.rule,
    snapshot: {
      totalRhcDays: input.totalRhcDays,
      skilledNursingMinutesOnRhcDays: input.skilledNursingMinutesOnRhcDays,
      rateScale: "share of RHC-day minutes (mean SN minutes per RHC day / 1440)",
    },
  });
  const mean = base.rate;
  return {
    ...base,
    rate: mean === null ? null : mean / HCI_MINUTES_PER_DAY,
    thresholdValue: base.thresholdValue === null ? null : base.thresholdValue / HCI_MINUTES_PER_DAY,
    computationSnapshot: { ...base.computationSnapshot, meanSkilledNursingMinutesPerRhcDay: mean },
  };
}
