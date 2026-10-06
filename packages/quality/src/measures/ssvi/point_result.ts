// @wardenx/quality — the shared reduction for the eight SSVI 0-or-1-point metrics. Pure. No IO.
//
// The SSVI inverts the HCI's polarity: a metric that crosses its cut EARNS a point of CONCERN. To keep the
// platform-wide result contract honest (`thresholdMet === true` means "fine", band green; a breach is red), an
// SSVI metric reports `thresholdMet = !pointAwarded`, band red when the point is awarded, and stamps the point
// itself in the snapshot as `ssviPoints` (0 or 1) — the number the composite sums. A metric below the
// reportable floor (`insufficient_n`) earns no point: CMS scores only a population that exists.
import type { MeasureComputationSnapshot, QualityMeasureValueResult } from "../result";
import { ratioResult } from "../result";
import { type SsviPointRule, ssviPointAwarded } from "./thresholds";

/** The snapshot key carrying a metric's SSVI points (read back by the composite). */
export const SSVI_POINTS_SNAPSHOT_KEY = "ssviPoints";

/** Build a binary SSVI metric result from its population counts and point rule. Pure. */
export function ssviBinaryMetricResult(args: {
  readonly metric: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly rule: SsviPointRule;
  readonly snapshot: MeasureComputationSnapshot;
}): QualityMeasureValueResult {
  const base = ratioResult({
    numerator: args.numerator,
    denominator: args.denominator,
    snapshot: {
      indicator: args.metric,
      ...args.snapshot,
      ssviRule: { direction: args.rule.direction, value: args.rule.value, label: args.rule.label },
      internalEstimate: true,
    },
  });
  if (base.rate === null) {
    return {
      ...base,
      thresholdValue: args.rule.value,
      computationSnapshot: { ...base.computationSnapshot, [SSVI_POINTS_SNAPSHOT_KEY]: 0 },
    };
  }
  const pointAwarded = ssviPointAwarded(base.rate, args.rule);
  return {
    ...base,
    thresholdMet: !pointAwarded,
    thresholdValue: args.rule.value,
    bandColor: pointAwarded ? "red" : "green",
    computationSnapshot: {
      ...base.computationSnapshot,
      [SSVI_POINTS_SNAPSHOT_KEY]: pointAwarded ? 1 : 0,
    },
  };
}

/** The SSVI points a (persisted or fresh) metric result carries; 0 when the snapshot has none. */
export function ssviPointsOf(result: Pick<QualityMeasureValueResult, "computationSnapshot">): number {
  const points = result.computationSnapshot?.[SSVI_POINTS_SNAPSHOT_KEY];
  return typeof points === "number" && Number.isFinite(points) ? points : 0;
}
