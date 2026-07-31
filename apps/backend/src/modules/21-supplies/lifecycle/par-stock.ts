// apps/backend/src/modules/21-supplies/lifecycle/par-stock.ts — M21-T03 (§2.7 / D5, §7.5).
//
// The supply hub's shelf, per (org, Location, SKU). Not patient data at all — which is why
// `M21ParThresholdPayload` carries no patientId and why these rows are retention class `operational` while
// every kit row is `compliance`.
//
// TWO DIVISIONS OF LABOUR THE SPEC IS EXPLICIT ABOUT, and both are easy to get backwards:
//
//   1. **The nightly cron is the canonical emitter; observations are not** (§7.5). A mid-day dispatch that
//      pushes a shelf below its reorder point adjusts the quantity and says nothing. Emitting on every
//      observation would produce an alert storm off imperfect counts, and the storm is what makes a team
//      stop reading par alerts — which is the actual failure mode this rule prevents.
//
//   2. **M21 may emit duplicates; M36 dedupes** (§7.5). So `runParMonitor` re-derives the band from the row
//      every night with no "already alerted" bookkeeping of its own. Bookkeeping here would be a second
//      source of truth that goes stale the first time a threshold is edited.
//
// The dispatch decrement REFUSES rather than clamps (see `@wardenx/supplies` `applyParDelta`): a hub asked
// for more than it had is the reorder signal, and clamping to zero deletes it.
import {
  applyParDelta,
  areParThresholdsOrdered,
  isBelowReorderPoint,
  isStockoutImminent,
  type ParStockLevels,
  type ParStockSeverity,
  parStockSeverity,
} from "@wardenx/supplies";
import type { IsoInstant, M21EventName, ParStockId } from "@wardenx/types";
import { type SupplySideEffect, withAudit } from "./effects";
import { SupplyStateError, require_ } from "./errors";

/** One `par_stock` row as the monitor reads it. */
export interface ParStockFacts extends ParStockLevels {
  readonly parStockId: ParStockId;
  readonly reorderQuantity: string;
  readonly unit: string;
  readonly isActive: boolean;
}

/** What the nightly `par-monitor` job decided for one row. */
export interface ParMonitorFinding {
  readonly parStockId: ParStockId;
  readonly severity: ParStockSeverity;
  /** The §4.5.2 events to emit, in order. `stockout_imminent` NEVER replaces `below_threshold`: a shelf at
   *  the safety floor is also below the reorder point, and the reorder queue must still see it. */
  readonly events: ReadonlyArray<M21EventName>;
  readonly observedAt: IsoInstant;
}

/**
 * §2.7 / §7.5 — evaluate one row. An inactive row is skipped entirely (it was retired from par management
 * at that Location on purpose); a row with no finding returns `severity: 'ok'` and an empty event list so
 * the caller can count what it looked at, not just what tripped.
 */
export function evaluateParStock(row: ParStockFacts, asOf: Date): ParMonitorFinding | null {
  if (!row.isActive) return null;

  const events: M21EventName[] = [];
  if (isBelowReorderPoint(row)) events.push("m21.par.below_threshold");
  if (isStockoutImminent(row)) events.push("m21.par.stockout_imminent");

  return {
    parStockId: row.parStockId,
    severity: parStockSeverity(row),
    events,
    observedAt: asOf.toISOString(),
  };
}

/** §2.7 — the whole nightly sweep for one Location, findings only for rows that tripped. */
export function runParMonitor(
  rows: ReadonlyArray<ParStockFacts>,
  asOf: Date,
): ReadonlyArray<ParMonitorFinding> {
  const findings: ParMonitorFinding[] = [];
  for (const row of rows) {
    const finding = evaluateParStock(row, asOf);
    if (finding !== null && finding.events.length > 0) findings.push(finding);
  }
  return findings;
}

/** §2.7 — what moves a shelf. A patient-side delivery is deliberately absent: it was already counted at
 *  dispatch, and counting it again is the double-decrement that empties a hub on paper. */
export type ParStockMovement =
  | { readonly kind: "dispatch_decrement"; readonly quantity: string }
  | { readonly kind: "vendor_receipt_increment"; readonly quantity: string }
  /** A physical recount by the supply team — the one movement that may set the shelf to any value. */
  | { readonly kind: "manual_adjustment"; readonly delta: string; readonly reviewedAt: IsoInstant };

/**
 * §2.7 / §2.10 — apply a movement to a shelf.
 *
 * Throws `M21_PAR_STOCK_INSUFFICIENT` when a dispatch decrement would drive the count negative. §2.5 makes
 * this a dispatch-blocking failure: the transition rolls back and the `dispatch_failed_validation` alert
 * names `par_stock_insufficient` as the reason, so the coordinator learns the shelf is empty BEFORE a
 * courier is dispatched to collect a kit that cannot be assembled.
 */
export function applyParStockMovement(
  row: ParStockFacts,
  movement: ParStockMovement,
): { readonly nextQuantity: string; readonly effects: ReadonlyArray<SupplySideEffect> } {
  require_(
    row.isActive,
    "M21_PAR_STOCK_INACTIVE",
    `par row ${row.parStockId} is retired from par management at this Location`,
  );

  const delta =
    movement.kind === "dispatch_decrement"
      ? `-${movement.quantity}`
      : movement.kind === "vendor_receipt_increment"
        ? movement.quantity
        : movement.delta;

  const applied = applyParDelta(row.currentQuantity, delta);
  if (!applied.ok) {
    throw new SupplyStateError(
      "M21_PAR_STOCK_INSUFFICIENT",
      `the hub is short by ${applied.shortBy} ${row.unit}`,
    );
  }

  const effects: SupplySideEffect[] = [
    { kind: "adjust_par_stock", delta, nextQuantity: applied.nextQuantity },
  ];
  if (movement.kind === "manual_adjustment") {
    effects.push({ kind: "set_timestamp", field: "last_par_review_at", at: movement.reviewedAt });
  }

  // NO threshold event here — §7.5 makes the nightly cron the canonical emitter (see the header).
  return { nextQuantity: applied.nextQuantity, effects: withAudit(effects) };
}

/** §2.10 — mirrors the `m21_par_stock_thresholds_ordered` CHECK at the write boundary, where an inverted
 *  threshold set is a field-anchored 422 instead of a 500 from the database. */
export function assertParThresholdsOrdered(input: {
  readonly reorderPoint: string;
  readonly minSafetyStock: string;
  readonly reorderQuantity: string;
}): void {
  require_(
    areParThresholdsOrdered(input),
    "M21_PAR_THRESHOLDS_INVERTED",
    "min_safety_stock must sit at or below reorder_point, and neither may be negative — an inverted pair makes the critical band unreachable",
  );
}
