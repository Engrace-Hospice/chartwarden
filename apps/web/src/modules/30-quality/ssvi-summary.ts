// apps/web/src/modules/30-quality — the PURE reduction behind the SSVI panel (FY2027, CMS-1851-F Table 9).
//
// The quality hub already lists every measure with its latest value; this folds the ten `ssvi_*` rows into what
// the panel shows: the 0–16 total (or, while metric 9 cannot be computed here, the honest lower bound and the
// most it could be), the outlier verdict (≥ 13), and per-metric points. Points come from the persisted value
// exactly as the server scored them: a binary metric earned its point when `thresholdMet === false` (the SSVI
// reports "concern" as a missed threshold); metric 9's points are its numerator. No React, no IO.

/** The slice of a quality-hub measure row this reduction reads. */
export interface SsviMeasureRow {
  readonly measureId: string;
  readonly displayName: string;
  readonly latestValue: {
    readonly numerator: number;
    readonly denominator: number;
    readonly rate: number | null;
    readonly thresholdMet: boolean | null;
    readonly bandColor: "green" | "yellow" | "red" | "insufficient_n";
    readonly unavailableReason: string | null;
    /** The calculator version that wrote this row (the hub's `computeVersion`). */
    readonly computeVersion: string;
  } | null;
}

/** The claims year of the cut table the panel prints (`ssvi-cms-golden.test.ts` pins it to the latest published). */
export const SSVI_CUT_DATA_FY = 2025;

/**
 * CMS Table 9 metric order, names, the cut CMS scored with (mirrors the latest table in `@chartwarden/quality`,
 * which this app cannot import — `ssvi-cms-golden.test.ts` pins the two together), max points, and `version`: the
 * calculator version the cut and the metric's definition belong to (the catalog's `calculatorVersion`, pinned the
 * same way). A stored row from an older version was scored under the old cut and inputs, so it is shown as not yet
 * computed instead of as a point decided under the wrong rule.
 */
export const SSVI_METRICS: readonly {
  readonly code: string;
  readonly name: string;
  readonly cut: string;
  readonly maxPoints: number;
  readonly version: string;
}[] = [
  {
    code: "ssvi_metric_01",
    name: "No CHC and no GIP provided",
    cut: "None provided",
    maxPoints: 1,
    version: "0.1.0",
  },
  {
    code: "ssvi_metric_02",
    name: "RHC days in a NF/SNF",
    cut: "≥ 40%",
    maxPoints: 1,
    version: "0.1.0",
  },
  {
    code: "ssvi_metric_03",
    name: "Last two RHC days of life with a skilled visit",
    cut: "≤ 87.5%",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_04",
    name: "Live-discharge share",
    cut: "≥ 47.0%",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_05",
    name: "Discharges with LOS of 180 days or more",
    cut: "≥ 33.3%",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_06",
    name: "Skilled-nursing minutes per RHC day",
    cut: "≤ 9.9 min",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_07",
    name: "Weekend RHC days with a skilled visit",
    cut: "≤ 4.8%",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_08",
    name: "Live discharges back to the same hospice within 7 days",
    cut: "≥ 18.2%",
    maxPoints: 1,
    version: "0.2.0",
  },
  {
    code: "ssvi_metric_09",
    name: "Total non-hospice spending",
    cut: "Octile, 0–8",
    maxPoints: 8,
    version: "0.1.0",
  },
];

export const SSVI_MAX_SCORE = 16;
export const SSVI_OUTLIER_SCORE = 13;
export const SSVI_INTERNAL_ESTIMATE_LABEL =
  "Internal estimate — CMS publishes the official SSVI from national Medicare claims.";

export type SsviMetricState = "point" | "no_point" | "low_n" | "not_computable" | "not_computed";

export interface SsviMetricSummary {
  readonly code: string;
  readonly name: string;
  readonly cut: string;
  readonly maxPoints: number;
  readonly row: SsviMeasureRow | null;
  /** Points earned, or null when unknown (not computable / not computed). */
  readonly points: number | null;
  readonly state: SsviMetricState;
}

export interface SsviSummary {
  readonly metrics: readonly SsviMetricSummary[];
  /** The total when all nine are known (from the persisted composite when present), else null. */
  readonly score: number | null;
  /** Sum of the known points — the floor the total cannot go below. */
  readonly lowerBound: number;
  /** The most the total could be once the unknown metrics are known. */
  readonly upperBound: number;
  /** true / false when decided (an outlier is decided once the lower bound reaches 13), null otherwise. */
  readonly outlier: boolean | null;
  /** Binary metrics (1–8) that earned their point. */
  readonly flagged: number;
  /** Whether any SSVI row exists at all (the family activates FY2027). */
  readonly present: boolean;
}

function metricState(
  row: SsviMeasureRow | null,
  maxPoints: number,
  version: string,
): {
  points: number | null;
  state: SsviMetricState;
} {
  const v = row?.latestValue ?? null;
  if (!v || v.computeVersion !== version) return { points: null, state: "not_computed" };
  if (v.unavailableReason) return { points: null, state: "not_computable" };
  if (maxPoints > 1) return { points: v.numerator, state: v.numerator > 0 ? "point" : "no_point" };
  if (v.bandColor === "insufficient_n" || v.denominator <= 0) return { points: 0, state: "low_n" };
  return v.thresholdMet === false
    ? { points: 1, state: "point" }
    : { points: 0, state: "no_point" };
}

/** Fold the hub's measure rows into the SSVI panel summary. Pure. */
export function summarizeSsvi(rows: readonly SsviMeasureRow[]): SsviSummary {
  const byCode = new Map(rows.map((r) => [r.measureId, r]));
  const metrics = SSVI_METRICS.map((m) => {
    const row = byCode.get(m.code) ?? null;
    return { ...m, row, ...metricState(row, m.maxPoints, m.version) };
  });
  let lowerBound = 0;
  let unknownMax = 0;
  for (const m of metrics) {
    if (m.points === null) unknownMax += m.maxPoints;
    else lowerBound += m.points;
  }
  const composite = byCode.get("ssvi_composite")?.latestValue ?? null;
  const allKnown = unknownMax === 0;
  // The stored composite is only trusted once every metric beside it is known under the current version: it was
  // summed from the metric rows as they stood, so beside a stale metric it would carry points scored under the
  // old cut into the headline.
  const score = allKnown
    ? composite && !composite.unavailableReason && composite.denominator > 0
      ? composite.numerator
      : lowerBound
    : null;
  const outlier =
    score !== null
      ? score >= SSVI_OUTLIER_SCORE
      : lowerBound >= SSVI_OUTLIER_SCORE
        ? true
        : lowerBound + unknownMax < SSVI_OUTLIER_SCORE
          ? false
          : null;
  return {
    metrics,
    score,
    lowerBound,
    upperBound: lowerBound + unknownMax,
    outlier,
    flagged: metrics.filter((m) => m.maxPoints === 1 && m.state === "point").length,
    present: rows.some((r) => r.measureId.startsWith("ssvi_")),
  };
}
