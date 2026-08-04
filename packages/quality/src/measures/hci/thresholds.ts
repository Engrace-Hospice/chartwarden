// @wardenx/quality — Hospice Care Index (HCI) per-FY threshold constants (§1.1, D2/D15). Pure data.
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
    // 8. Skilled Nursing Care Minutes per Routine Home Care day — higher is better (rate is RHC-days with
    //    SN minutes at/above the per-day floor).
    indicator_08: { value: 0.5, direction: "gte", label: "RHC days meeting SN-minutes floor" },
    // 9. Skilled Nursing Minutes on Weekends — higher is better.
    indicator_09: { value: 0.5, direction: "gte", label: "weekend days meeting SN-minutes floor" },
    // 10. Visits Near Death — higher is better.
    indicator_10: { value: 0.8, direction: "gte", label: "decedents visited in last days of life" },
  },
};

/** FY2026 HCI thresholds — carried forward from FY2025 (no CMS technical-spec change at this revision). */
export const HCI_THRESHOLDS_v2026: HciThresholdTable = {
  ...HCI_THRESHOLDS_v2025,
  fiscalYear: 2026,
};
