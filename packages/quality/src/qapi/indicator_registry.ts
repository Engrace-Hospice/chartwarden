// @wardenx/quality — QAPI indicator data-path registry + threshold-band evaluation (M30-P2a). Pure,
// IO-free.
//
// A `qapi_indicator.data_path` (V-9) binds a tracked indicator to its data source: either a platform
// quality measure (`measure:<measureCode>`) or a tenant-defined custom source (`custom:<key>`). This
// module is the pure core that (1) parses + validates a data path, (2) resolves a `measure:`-bound path
// to its underlying {@link MeasureId}, (3) evaluates a measured value against an indicator's red/yellow/
// green threshold band, and (4) enforces the tenant-tighten-only rule — a tenant may make a threshold
// STRICTER than the platform floor but never LOOSER. No IO; the registry is a const catalog the route
// projects from.
import { ChartWardenError } from "@wardenx/types";
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

/**
 * The platform-shipped QAPI indicator registry (V-9): the canonical `measure:`-bound data paths and the
 * platform-floor thresholds the tenant may only tighten. Tenants add `custom:` indicators that are NOT
 * in this registry (they carry tenant-defined thresholds with no platform floor to tighten against).
 */
export const QAPI_INDICATOR_REGISTRY: Readonly<Record<string, IndicatorBinding>> = {
  // Hospice Care Index composite (0–100; higher is better).
  "measure:hci_composite": {
    measureId: "hci_composite",
    platformFloor: { direction: "higher_is_better", yellow: 90, red: 80 },
  },
  // Hospice Visits in the Last Days of Life (proportion 0–1; higher is better).
  "measure:hvldl": {
    measureId: "hvldl",
    platformFloor: { direction: "higher_is_better", yellow: 0.9, red: 0.8 },
  },
  // CAHPS Hospice — "Willing to Recommend" top-box percentage (0–100; higher is better).
  "measure:cahps_recommend": {
    measureId: "cahps_recommend",
    platformFloor: { direction: "higher_is_better", yellow: 85, red: 75 },
  },
  // Timely follow-up / responsiveness adverse rate (per 100; lower is better).
  "measure:responsiveness_adverse_rate": {
    measureId: "responsiveness_adverse_rate",
    platformFloor: { direction: "lower_is_better", yellow: 5, red: 10 },
  },
};

/** The parsed shape of a `qapi_indicator.data_path` (V-9). */
export interface ParsedDataPath {
  readonly kind: "measure" | "custom";
  /** For `measure:` the measure code; for `custom:` the tenant-defined source key. */
  readonly ref: string;
}

/**
 * Parse + validate a `qapi_indicator.data_path` (V-9). The legal forms are `measure:<code>` and
 * `custom:<key>`, each with a non-empty ref. Throws {@link ChartWardenError} `QAPI_INVALID_DATA_PATH` on an
 * unknown prefix or empty ref.
 */
export function parseDataPath(dataPath: string): ParsedDataPath {
  const sep = dataPath.indexOf(":");
  const prefix = sep === -1 ? "" : dataPath.slice(0, sep);
  const ref = sep === -1 ? "" : dataPath.slice(sep + 1).trim();
  if ((prefix !== "measure" && prefix !== "custom") || ref.length === 0) {
    throw new ChartWardenError(
      "QAPI_INVALID_DATA_PATH",
      `'${dataPath}' is not a valid indicator data_path (expected 'measure:<code>' or 'custom:<key>')`,
      422,
    );
  }
  return { kind: prefix, ref };
}

/**
 * Resolve a `measure:`-bound data path to its underlying {@link MeasureId}. Throws
 * {@link ChartWardenError} `QAPI_INDICATOR_NOT_REGISTERED` if the data path is a `measure:` path that is not
 * in {@link QAPI_INDICATOR_REGISTRY}, or `QAPI_DATA_PATH_NOT_MEASURE_BOUND` for a `custom:` path (which
 * has no platform measure binding). The ref of an unregistered `measure:` path is NOT trusted.
 */
export function resolveMeasureId(dataPath: string): MeasureId {
  const parsed = parseDataPath(dataPath);
  if (parsed.kind === "custom") {
    throw new ChartWardenError(
      "QAPI_DATA_PATH_NOT_MEASURE_BOUND",
      `'${dataPath}' is a custom indicator and is not bound to a platform measure`,
      422,
    );
  }
  const binding = QAPI_INDICATOR_REGISTRY[dataPath];
  if (binding === undefined) {
    throw new ChartWardenError(
      "QAPI_INDICATOR_NOT_REGISTERED",
      `'${dataPath}' is not a registered platform indicator`,
      422,
    );
  }
  return binding.measureId;
}

/**
 * Evaluate a measured `value` against an indicator's `thresholds`, returning the traffic-light band. The
 * boundaries are inclusive on the better side: for `higher_is_better`, `value ≥ yellow → green`,
 * `value ≥ red → yellow`, else `red`; for `lower_is_better`, `value ≤ yellow → green`, `value ≤ red →
 * yellow`, else `red`. A yellow→red transition is the WF-07 breach edge that charters a project.
 */
export function evaluateBand(value: number, thresholds: IndicatorThresholds): ThresholdBand {
  if (thresholds.direction === "higher_is_better") {
    if (value >= thresholds.yellow) return "green";
    if (value >= thresholds.red) return "yellow";
    return "red";
  }
  if (value <= thresholds.yellow) return "green";
  if (value <= thresholds.red) return "yellow";
  return "red";
}

/**
 * Tenant-tighten-only enforcement: a tenant may set thresholds STRICTER than the platform floor but
 * never LOOSER (the platform floor is a survey-mandated minimum). For `higher_is_better`, "stricter"
 * means RAISING both boundaries (demanding a higher value to stay out of yellow/red); for
 * `lower_is_better`, "stricter" means LOWERING both boundaries. The direction must match the floor.
 * Throws {@link ChartWardenError} `QAPI_INDICATOR_THRESHOLD_LOOSENED` if the tenant band loosens the floor.
 */
export function assertTenantTighten(
  platformFloor: IndicatorThresholds,
  tenant: IndicatorThresholds,
): void {
  if (tenant.direction !== platformFloor.direction) {
    throw new ChartWardenError(
      "QAPI_INDICATOR_THRESHOLD_LOOSENED",
      "a tenant threshold may not change the platform-floor direction",
      422,
    );
  }
  const loosened =
    platformFloor.direction === "higher_is_better"
      ? tenant.yellow < platformFloor.yellow || tenant.red < platformFloor.red
      : tenant.yellow > platformFloor.yellow || tenant.red > platformFloor.red;
  if (loosened) {
    throw new ChartWardenError(
      "QAPI_INDICATOR_THRESHOLD_LOOSENED",
      "a tenant may only tighten (never loosen) an indicator's platform-floor threshold",
      422,
    );
  }
}
