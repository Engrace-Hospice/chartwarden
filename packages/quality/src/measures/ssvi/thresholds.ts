// @chartwarden/quality — Service and Spending Variation Index (SSVI) per-FY thresholds. Pure data. No IO.
//
// The SSVI is CMS's claims-only program-integrity scoring tool, introduced in the FY2027 hospice final rule
// (CMS-1851-F, 91 FR 49118, §III.B.2, Table 9). Nine metrics: eight utilization metrics worth 0 or 1 point,
// plus total non-hospice spending worth 0-8 points by octile of hospices, for a total of 0-16. FR-F: "We would
// consider a hospice with 13 or more points an outlier as it would be at 99th percentile". Higher = more concern.
//
// What it is NOT: not an HQRP measure, not on Care Compare, not submitted by the hospice (no preview, no
// reconsideration). CMS computes and publishes it. It does NOT replace the HCI ("the measures are claims-based
// and will not replace any existing measures"), so the HCI family stays as it is. Everything this platform
// computes for the SSVI is an INTERNAL ESTIMATE from the agency's own records, labelled as such end to end.
//
// THRESHOLDS ARE PER DATA YEAR. CMS recomputes the percentile cuts every fiscal year from that year's national
// claims ("We plan to determine the SSVI for individual hospices each FY using that applicable year's data").
// The values below are the FY2025-claims cuts CMS published with the FY2027 rule — a single reviewed constant
// PR adds the next year's table when CMS publishes it. Source: docs/research/FY2027_HOSPICE_COP_RESEARCH.md §7.

/** The nine SSVI metric keys, in CMS Table 9 order. */
export type SsviMetricKey =
  | "metric_01"
  | "metric_02"
  | "metric_03"
  | "metric_04"
  | "metric_05"
  | "metric_06"
  | "metric_07"
  | "metric_08"
  | "metric_09";

/** The eight 0-or-1-point metrics (metric 9, spending, is scored by octile instead). */
export type SsviBinaryMetricKey = Exclude<SsviMetricKey, "metric_09">;

/**
 * When a binary metric awards its point: `gte` = the rate is at or above `value`, `lte` = at or below. The
 * comparison is INCLUSIVE on the concern side, matching CMS's "≥ 75th percentile" / "≤ 25th percentile".
 * `value` is a proportion in [0, 1], except metric 6 whose CMS unit is minutes per RHC day.
 */
export interface SsviPointRule {
  readonly direction: "gte" | "lte";
  readonly value: number;
  readonly label: string;
}

/** One data year's SSVI cut table. */
export interface SsviThresholdTable {
  /** The fiscal year of the CLAIMS the percentiles were computed from. */
  readonly dataFiscalYear: number;
  /** Where CMS published this table. */
  readonly publishedIn: string;
  /** Highest possible total (8 binary points + 8 spending points). */
  readonly maxScore: number;
  /** A total at or above this is an SSVI outlier (≈ the 99th percentile). */
  readonly outlierScore: number;
  readonly metrics: Readonly<Record<SsviBinaryMetricKey, SsviPointRule>>;
  /**
   * Metric 9 octile UPPER bounds in whole cents, ascending (7 values). Spending of $0 scores 0; spending > 0 and
   * ≤ bound[0] scores 1, ≤ bound[1] scores 2, ..., above bound[6] scores 8. Each band's lower bound is exclusive.
   */
  readonly spendingOctileUpperBoundsCents: readonly number[];
}

/** The SSVI maximum total: eight binary points plus eight spending points. */
export const SSVI_MAX_SCORE = 16;
/** FR-F: 13 or more points is an outlier (≈ 99th percentile). */
export const SSVI_OUTLIER_SCORE = 13;

/** FY2025 claims, published with the FY2027 final rule (CMS-1851-F, Table 9). */
export const SSVI_THRESHOLDS_FY2025_DATA: SsviThresholdTable = {
  dataFiscalYear: 2025,
  publishedIn: "FY2027 Hospice final rule, CMS-1851-F, 91 FR 49118 (Table 9)",
  maxScore: SSVI_MAX_SCORE,
  outlierScore: SSVI_OUTLIER_SCORE,
  metrics: {
    // 1. Providing no Continuous Home Care and no General Inpatient Care — the point when NONE was provided
    //    (rate = share of election periods with any CHC/GIP day; zero means none).
    metric_01: { direction: "lte", value: 0, label: "no CHC and no GIP provided" },
    // 2. Percentage of RHC days provided in a nursing home or skilled nursing facility — ≥ 40%.
    metric_02: { direction: "gte", value: 0.4, label: "share of RHC days in a NF/SNF ≥ 40%" },
    // 3. Percent of the last two RHC days of life with visits — ≤ 25th percentile (85.7%).
    metric_03: {
      direction: "lte",
      value: 0.857,
      label: "decedents whose last two RHC days had a skilled visit ≤ 85.7% (25th pct)",
    },
    // 4. Percentage of total discharges that are live discharges — ≥ 75th percentile (47.5%).
    metric_04: { direction: "gte", value: 0.475, label: "live-discharge share ≥ 47.5% (75th pct)" },
    // 5. Percentage of discharges with a length of stay over 180 days — ≥ 75th percentile (33.2%).
    metric_05: {
      direction: "gte",
      value: 0.332,
      label: "discharges with LOS > 180 days ≥ 33.2% (75th pct)",
    },
    // 6. Average skilled nursing minutes on RHC — ≤ 25th percentile (9.8 minutes per RHC day).
    metric_06: {
      direction: "lte",
      value: 9.8,
      label: "mean skilled-nursing minutes per RHC day ≤ 9.8 (25th pct)",
    },
    // 7. Weekend RHC days with a skilled visit as a share of all RHC days — ≤ 25th percentile (4.8%).
    metric_07: {
      direction: "lte",
      value: 0.048,
      label: "weekend RHC days with a skilled visit ≤ 4.8% of RHC days (25th pct)",
    },
    // 8. Live discharges where the beneficiary returns to the same hospice within seven days — ≥ 75th pct (15%).
    metric_08: {
      direction: "gte",
      value: 0.15,
      label: "live discharges readmitted to the same hospice within 7 days ≥ 15% (75th pct)",
    },
  },
  // 9. Total non-hospice spending: $6,352.84 / $20,612.10 / $42,911.79 / $76,801.05 / $133,440.80 /
  //    $246,123.10 / $517,204.40.
  spendingOctileUpperBoundsCents: [
    635_284, 2_061_210, 4_291_179, 7_680_105, 13_344_080, 24_612_310, 51_720_440,
  ],
};

/** Every published SSVI cut table, keyed by the data fiscal year. */
export const SSVI_THRESHOLD_TABLES: Readonly<Record<number, SsviThresholdTable>> = {
  [SSVI_THRESHOLDS_FY2025_DATA.dataFiscalYear]: SSVI_THRESHOLDS_FY2025_DATA,
};

/**
 * The cut table to score `dataFiscalYear`'s data with: that year's table when CMS has published it, else the
 * most recent EARLIER table (the cuts are re-derived each year, so the latest published is the best stand-in),
 * else the earliest table on file. Never null — the SSVI is always scored against SOME published cut, and the
 * snapshot records which (`dataFiscalYear`).
 */
export function ssviThresholdsFor(dataFiscalYear: number): SsviThresholdTable {
  const years = Object.keys(SSVI_THRESHOLD_TABLES)
    .map(Number)
    .sort((a, b) => a - b);
  const atOrBefore = years.filter((y) => y <= dataFiscalYear);
  const chosen = atOrBefore.length > 0 ? atOrBefore[atOrBefore.length - 1] : years[0];
  return SSVI_THRESHOLD_TABLES[chosen as number] as SsviThresholdTable;
}

/** Metric 9 points for a total non-hospice spend (whole cents) against a table's octile bounds. Pure. */
export function ssviSpendingPoints(
  nonHospiceSpendingCents: number,
  upperBoundsCents: readonly number[],
): number {
  if (!(nonHospiceSpendingCents > 0)) return 0;
  const band = upperBoundsCents.findIndex((bound) => nonHospiceSpendingCents <= bound);
  return band === -1 ? upperBoundsCents.length + 1 : band + 1;
}

/** Does a binary metric's rate earn its point under `rule`? Inclusive on the concern side. Pure. */
export function ssviPointAwarded(rate: number, rule: SsviPointRule): boolean {
  return rule.direction === "gte" ? rate >= rule.value : rate <= rule.value;
}

/** The label every SSVI surface carries: this is the agency's own estimate, not the CMS-published score. */
export const SSVI_INTERNAL_ESTIMATE_NOTICE =
  "Internal estimate from this agency's own records. CMS calculates and publishes the official SSVI from national Medicare claims; hospices submit nothing and there is no preview or reconsideration.";
