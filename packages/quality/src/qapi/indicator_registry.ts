// @chartwarden/quality — QAPI indicator data-path registry + threshold-band evaluation (M30-P2a). Pure,
// IO-free.
//
// A `qapi_indicator.data_path` (V-9) binds a tracked indicator to its data source: either a platform
// quality measure (`measure:<measureCode>`) or a tenant-defined custom source (`custom:<key>`). This
// module is the pure core that (1) parses + validates a data path, (2) resolves a `measure:`-bound path
// to its underlying {@link MeasureId}, (3) evaluates a measured value against an indicator's red/yellow/
// green threshold band, and (4) enforces the tenant-tighten-only rule — a tenant may make a threshold
// STRICTER than the platform floor but never LOOSER. No IO; the registry is a const catalog the route
// projects from.
import type { MeasureId } from "../contracts";

/** The traffic-light band an indicator's current value falls into (yellow→red is the breach edge, WF-07). */
export type ThresholdBand = "green" | "yellow" | "red";

/** Whether a higher measured value is better (e.g., visit composites) or worse (e.g., adverse rates). */
export type MeasureDirection = "higher_is_better" | "lower_is_better";

/**
 * A platform-floor threshold band for an indicator. `yellow` is the green↔yellow boundary; `red` is the
 * yellow↔red boundary. For `higher_is_better`, `yellow ≥ red` (you fall through green→yellow→red as the
 * value drops); for `lower_is_better`, `yellow ≤ red` (you climb green→yellow→red as the value rises).
 */
export interface IndicatorThresholds {
  readonly direction: MeasureDirection;
  /** The green↔yellow boundary value. */
  readonly yellow: number;
  /** The yellow↔red boundary value. */
  readonly red: number;
}

/** One registered platform indicator binding: the data path → its measure + platform-floor thresholds. */
export interface IndicatorBinding {
  /** The underlying measure code this indicator tracks (V-9 `measure:` data path). */
  readonly measureId: MeasureId;
  /** The platform-floor band a tenant may only tighten. */
  readonly platformFloor: IndicatorThresholds;
}

/** The parsed shape of a `qapi_indicator.data_path` (V-9). */
export interface ParsedDataPath {
  readonly kind: "measure" | "custom";
  /** For `measure:` the measure code; for `custom:` the tenant-defined source key. */
  readonly ref: string;
}
