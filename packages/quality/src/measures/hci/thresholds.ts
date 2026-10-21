// @chartwarden/quality — Hospice Care Index (HCI) per-FY threshold constants (§1.1, D2/D15). Pure data.
//
// The HCI score is the COUNT of the ten indicators whose rate meets the CMS-published threshold for the
// reporting period (max 10). Each indicator's threshold value AND direction (higher-is-better vs lower-is-
// better) is CMS-published and changes by fiscal year — so it lives here as a versioned constant, NOT
// reverse-engineered across ten calculators (D2). Tenants may TIGHTEN a target via `qapi_indicator`, never
// loosen below this CMS floor (D15).
import type { ThresholdRule } from "../result";

/** The ten HCI indicator keys, in CMS publication order. */
export type HciIndicatorKey =
  | "indicator_01"
  | "indicator_02"
  | "indicator_03"
  | "indicator_04"
  | "indicator_05"
  | "indicator_06"
  | "indicator_07"
  | "indicator_08"
  | "indicator_09"
  | "indicator_10";

/** Per-FY HCI threshold table: one directional {@link ThresholdRule} per indicator, plus context. */
export interface HciThresholdTable {
  /** The federal fiscal year these thresholds apply to. */
  readonly fiscalYear: number;
  /** The composite-score cut at/above which the HCI is "above the national average" (D15: ≥ 7/10). */
  readonly compositeAboveAverageScore: number;
  /** The CMS national-average HVLDL rate the §4.11 Risk-Register flag compares against. */
  readonly hvldlNationalAvg: number;
  /** The directional threshold per indicator. */
  readonly indicators: Readonly<Record<HciIndicatorKey, ThresholdRule>>;
}

// NOTE: the numeric cut values below are the platform-shipped FY2025 defaults; a CMS technical-spec
// refresh updates them in a single reviewed constant PR. Directions encode the CMS "better" sense:
// `gte` = higher-is-better (more care delivered), `lte` = lower-is-better (fewer adverse events).
//
// IMPORTANT — these are fixed-value APPROXIMATIONS, not CMS-exact cuts. CMS actually scores each real
// HCI indicator by where a hospice's rate falls in the NATIONAL PERCENTILE distribution across all
// Medicare-certified hospices for the period (e.g. "below the 90th percentile" for early live
// discharges), computed centrally from 100% Medicare FFS claims. No single-tenant EHR — ChartWarden
// included — has that cross-hospice national distribution, so a true CMS-faithful score can never be
// computed here regardless of how these constants are tuned; this table is the platform's best static
// stand-in, not a spec-pinned value (verified against CMS/secondary sources 2026-08-07, see
// `m30-hci-research-2026-08-07` memory).
export const HCI_THRESHOLDS_v2025: HciThresholdTable = {
  fiscalYear: 2025,
  compositeAboveAverageScore: 7,
  hvldlNationalAvg: 0.62,
  indicators: {
    // 1. Continuous Home Care or General Inpatient provided — higher is better.
    indicator_01: { value: 0.01, direction: "gte", label: "any CHC or GIP day provided" },
    // 2. Gaps in Skilled Nursing visits — lower is better.
    indicator_02: { value: 0.13, direction: "lte", label: "skilled-nursing visit gap rate" },
    // 3. Early Live Discharges — lower is better.
    indicator_03: { value: 0.1, direction: "lte", label: "early (≤ day-7) live-discharge rate" },
    // 4. Late Live Discharges — lower is better.
    indicator_04: { value: 0.13, direction: "lte", label: "late live-discharge rate" },
    // 5. Burdensome Transitions Type 1 — lower is better.
    indicator_05: { value: 0.02, direction: "lte", label: "burdensome transition type-1 rate" },
    // 6. Burdensome Transitions Type 2 — lower is better.
    indicator_06: { value: 0.02, direction: "lte", label: "burdensome transition type-2 rate" },
    // 7. Per-beneficiary Medicare spending — lower is better (rate is spend ÷ benchmark, ≤ 1.0 is good).
    indicator_07: {
      value: 1.0,
      direction: "lte",
      label: "per-beneficiary spend vs benchmark ratio",
    },
    // 8. Skilled Nursing Care Minutes per Routine Home Care day — higher is better. CMS's value is the MEAN
    //    skilled-nursing minutes per RHC day, so this cut is in MINUTES per RHC day, not a proportion
    //    (`computeHciIndicator08` decides the verdict on the mean and rescales only the stored `rate`).
    //    Approximation: CMS scores it against the national percentile distribution; 15 minutes per RHC
    //    day is the platform's static stand-in (roughly two one-hour RN visits a week).
    indicator_08: {
      value: 15,
      direction: "gte",
      label:
        "skilled-nursing minutes per RHC day (platform approximation of the CMS percentile cut)",
    },
    // 9. Skilled Nursing Minutes on Weekends — higher is better. The rate is the SHARE of skilled-nursing
    //    minutes on RHC days delivered on a Saturday or Sunday. Approximation: CMS scores it by national
    //    percentile; 5% is the platform's static stand-in.
    indicator_09: {
      value: 0.05,
      direction: "gte",
      label:
        "share of skilled-nursing minutes on weekends (platform approximation of the CMS percentile cut)",
    },
    // 10. Visits Near Death — higher is better.
    indicator_10: { value: 0.8, direction: "gte", label: "decedents visited in last days of life" },
  },
};

// ── platform reduction constants (NOT CMS-published in this form) ───────────────────────────────────────
//
// Indicator 2 is defined by CMS over the national claims distribution, scored by percentile, and needs one
// number the platform has to choose: how long a stretch without a nurse is a gap. It is declared HERE,
// beside the threshold table and under the same caveat, so it sits in one reviewed place rather than buried
// in a worker — and so a reader can see that it is the platform's reading, not a spec value.
//
// (Indicators 8 and 9 need no such constant: they follow the CMS definitions directly — mean skilled-nursing
// minutes per RHC day, and the weekend share of those minutes — see `skilled_nursing_minutes.ts`.)
/**
 * ★ PLATFORM CONSTANT — days between skilled-nursing visits after which indicator 2 counts an election as
 * having a GAP. Seven days matches the CMS HCI narrative description ("more than seven days between skilled
 * nursing visits"), which is a published anchor; it is still listed
 * as a platform constant because the technical spec computes it over claim lines, not encounter records.
 */
export const HCI_SKILLED_NURSING_GAP_DAYS = 7;

/** FY2026 HCI thresholds — carried forward from FY2025 (no CMS technical-spec change at this revision). */
export const HCI_THRESHOLDS_v2026: HciThresholdTable = {
  ...HCI_THRESHOLDS_v2025,
  fiscalYear: 2026,
};
