// @chartwarden/supplies — the §2.7 / D5 par-stock arithmetic.
//
// `par_stock.current_quantity`, `reorder_point` and `min_safety_stock` are `numeric` columns, so every
// quantity here is a decimal STRING and every comparison goes through Decimal. A shelf count that drifts by
// a float epsilon either fires a stockout alert nobody believes or withholds one somebody needed.
//
// SEVERITY IS DERIVED, NEVER STORED (the §3.1.6 header states this as the schema's reason for dropping the
// §3.2 draft's `current_severity` column): a stored severity goes stale the moment a threshold is edited,
// and the screen reading it would then show a green shelf that is actually empty.
//
// SPEC RECONCILIATION (§7.5 ↔ §3.1.6): §7.5 words the three bands against a `par_minimum` model — `depleted`
// at zero, `critical_low` at ≤ 25% of par-min, `below_threshold` otherwise. §3.1 is normative and ships
// `reorder_point` + `min_safety_stock` instead, so the bands bind to THOSE: `critical_low` is "at or below
// the safety floor" rather than an arithmetic 25%. The band NAMES are kept verbatim because
// `ParBelowThresholdAlert.severity` (locked in M21-T01) publishes them on the wire.
//
// PURE — no IO, no clock.

import { Decimal } from "decimal.js";

/** §7.5 — the alert band a shelf is in. `ok` is the fourth, unpublished band: nothing fires. */
export type ParStockSeverity = "ok" | "below_threshold" | "critical_low" | "depleted";

/** The three columns the bands are read against, as they come off the row. */
export interface ParStockLevels {
  readonly currentQuantity: string;
  readonly reorderPoint: string;
  readonly minSafetyStock: string;
}

/**
 * §7.5 / §3.1.6 — which band this shelf is in.
 *
 * `depleted` is deliberately its own band rather than the bottom of `critical_low`: a depleted hub cannot
 * fill the next dispatch AT ALL, which is a different conversation from "order more this week". A tenant
 * that set `min_safety_stock = 0` would otherwise never see the distinction.
 */
export function parStockSeverity(levels: ParStockLevels): ParStockSeverity {
  const current = new Decimal(levels.currentQuantity);
  if (current.lessThanOrEqualTo(0)) return "depleted";
  if (current.lessThanOrEqualTo(levels.minSafetyStock)) return "critical_low";
  if (current.lessThanOrEqualTo(levels.reorderPoint)) return "below_threshold";
  return "ok";
}

/** §2.7 — at or below the reorder point (the `m21.par.below_threshold` condition). */
export function isBelowReorderPoint(levels: ParStockLevels): boolean {
  return new Decimal(levels.currentQuantity).lessThanOrEqualTo(levels.reorderPoint);
}

/** §2.7 — at or below the safety floor (the `m21.par.stockout_imminent` condition). */
export function isStockoutImminent(levels: ParStockLevels): boolean {
  return new Decimal(levels.currentQuantity).lessThanOrEqualTo(levels.minSafetyStock);
}

/**
 * §2.10 — mirrors the `m21_par_stock_thresholds_ordered` CHECK. Inverted thresholds make the `critical_low`
 * band unreachable, so the shelf empties without ever escalating — the failure mode is silence, which is why
 * the service refuses the write rather than letting the database be the only thing that noticed.
 */
export function areParThresholdsOrdered(levels: {
  readonly reorderPoint: string;
  readonly minSafetyStock: string;
  readonly reorderQuantity: string;
}): boolean {
  const min = new Decimal(levels.minSafetyStock);
  const reorder = new Decimal(levels.reorderPoint);
  return (
    min.greaterThanOrEqualTo(0) &&
    reorder.greaterThanOrEqualTo(min) &&
    new Decimal(levels.reorderQuantity).greaterThanOrEqualTo(0)
  );
}

export type ParDeltaResult =
  | { readonly ok: true; readonly nextQuantity: string }
  /** The decrement would drive the shelf negative — §2.10's `par_stock_insufficient`. */
  | { readonly ok: false; readonly shortBy: string };

/**
 * §2.7 — apply a signed quantity change. A dispatch decrements; a vendor shipment receipt increments; a
 * patient-side delivery does NEITHER (it was already counted at dispatch — counting it twice is the classic
 * double-decrement that empties a hub on paper).
 *
 * A decrement past zero is REFUSED rather than clamped: clamping would silently lose the fact that the hub
 * was asked for more than it had, and that fact is the reorder signal.
 */
export function applyParDelta(currentQuantity: string, delta: string): ParDeltaResult {
  const next = new Decimal(currentQuantity).plus(delta);
  if (next.isNegative()) return { ok: false, shortBy: next.abs().toString() };
  return { ok: true, nextQuantity: next.toString() };
}
