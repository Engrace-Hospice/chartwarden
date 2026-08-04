// @wardenx/emar — §2.7 D5 comfort-kit deployment + drawdown (M13-T05). PURE, IO-free, `Date.now()`-free.
//
// A comfort kit is a per-patient stock of common end-of-life medications placed at the bedside for PRN
// administration. The kit *inventory* is M21's domain; M13 owns the clinical record of the kit being at THIS
// bedside and what has been drawn from it. This module is the pure core of that surface (the M13-T08 worker
// binds the seam reads + the row writes):
//   - `buildComfortKitDeployment` materializes a deployment + per-content drawdown rows from the
//     `m21.comfort_kit.deployed_at_patient` envelope (a recorded fixture today, M21 forward-seam precedent).
//   - `applyKitDrawdown` decrements a drawdown by (administered + wastage), rejecting a negative result with
//     `KIT_INSUFFICIENT_QUANTITY` (survey-defensibility requires the kit count match), and evaluates the
//     `m13.comfort_kit.replenishment_needed` signal at the threshold.
//   - `reconcileKitReturnLine` / `applyKitReturn` consume the M21 return + return-reconciliation fixtures and
//     surface the controlled-substance discrepancy signal.
// Every fact (quantities, the recent-PRN-count, the instants) is injected, so the math is deterministic and
// unit-testable with no DB and no clock — the M13-T03/T04 pure-domain precedent.
import type {
  AdmissionId,
  ComfortKitDeploymentId,
  IsoInstant,
  MedicationOrderId,
  PatientId,
} from "@wardenx/types";
import { AdministrationStateError } from "../lifecycle/errors";

/** §2.7 — default replenishment threshold: 25% of the deployed (`expectedQuantity`) amount. */
export const DEFAULT_REPLENISHMENT_THRESHOLD_FRACTION = 0.25;
/** §2.7 — `urgent` replenishment floor: remaining at/below 10% of the deployed amount. */
export const URGENT_REPLENISHMENT_FRACTION = 0.1;
/** §2.7 — `urgent` replenishment trigger on burn rate: ≥3 PRN administrations of the order in the last 24h. */
export const URGENT_PRN_COUNT_24H = 3;
/** §2.7 — a controlled-substance return-discrepancy at/above 5% of the deployed amount is survey-investigable. */
export const CONTROLLED_DISCREPANCY_FRACTION = 0.05;

// ── Deployment (consumes `m21.comfort_kit.deployed_at_patient`) ──────────────────────────────────────────

/** §2.7 — one content line of the deployed kit (one `medication_order` placed at the bedside). */
export interface KitContentLine {
  readonly medicationOrderId: MedicationOrderId;
  readonly expectedQuantity: number;
  readonly expectedUnit: string;
  readonly lotNumber: string | null;
  readonly expirationDate: string | null;
  /** Per-medication replenishment-threshold override (M21 kit template); fraction of `expectedQuantity`. */
  readonly replenishmentThresholdFraction?: number | null;
  /** Whether this kit medication is a controlled substance (resolved via the M12 seam upstream). */
  readonly isControlled?: boolean;
}

/** §2.7 — the `m21.comfort_kit.deployed_at_patient` envelope (M21 fixture today; the forward-seam precedent). */
export interface ComfortKitDeployedEnvelope {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly deployedAtIso: IsoInstant;
  readonly deployedByMembershipId: string;
  readonly contents: readonly KitContentLine[];
}

/** §2.7 — one materialized `comfort_kit_drawdown` row, initialized at the deployed quantity. */
export interface KitDrawdownInit {
  readonly comfortKitDeploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly remainingQuantity: number;
  readonly expectedQuantity: number;
  readonly expectedUnit: string;
  readonly replenishmentThreshold: number;
  readonly lotNumber: string | null;
  readonly expirationDate: string | null;
  readonly isControlled: boolean;
}

/** §2.7 — the `m13.comfort_kit.deployed` outbox payload (M14/M33 consume; no PHI, only IDs + content shape). */
export interface ComfortKitDeployedSignal {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly contents: readonly {
    readonly medicationOrderId: MedicationOrderId;
    readonly expectedQuantity: number;
    readonly expectedUnit: string;
  }[];
}

/** §2.7 — the full deployment plan: the per-line drawdown inits + the `m13.comfort_kit.deployed` signal. */
export interface ComfortKitDeploymentPlan {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly drawdowns: readonly KitDrawdownInit[];
  readonly deployedSignal: ComfortKitDeployedSignal;
}

/** Resolve a per-line replenishment threshold (override fraction → default 25%), clamped to [0, expected]. */
function resolveThreshold(line: KitContentLine): number {
  const f = line.replenishmentThresholdFraction;
  const fraction =
    typeof f === "number" && Number.isFinite(f) && f >= 0
      ? f
      : DEFAULT_REPLENISHMENT_THRESHOLD_FRACTION;
  return Math.min(line.expectedQuantity, line.expectedQuantity * fraction);
}

/**
 * §2.7 — materialize a `comfort_kit_deployment` + one `comfort_kit_drawdown` per content line, each initialized
 * at `remaining_quantity = expectedQuantity` with the resolved replenishment threshold. Rejects an empty kit
 * (`KIT_INSUFFICIENT_QUANTITY`) and any non-positive content quantity (a deployed line must hold something).
 * Pure — the consumer worker (M13-T08) persists the returned rows + emits `deployedSignal` in one transaction.
 */
export function buildComfortKitDeployment(
  envelope: ComfortKitDeployedEnvelope,
): ComfortKitDeploymentPlan {
  if (envelope.contents.length === 0) {
    throw new AdministrationStateError(
      "KIT_INSUFFICIENT_QUANTITY",
      "a comfort-kit deployment must carry at least one medication line",
    );
  }
  const drawdowns: KitDrawdownInit[] = envelope.contents.map((line) => {
    if (!Number.isFinite(line.expectedQuantity) || line.expectedQuantity <= 0) {
      throw new AdministrationStateError(
        "KIT_INSUFFICIENT_QUANTITY",
        `comfort-kit content for order ${line.medicationOrderId} must have a positive expected quantity`,
      );
    }
    return {
      comfortKitDeploymentId: envelope.deploymentId,
      medicationOrderId: line.medicationOrderId,
      remainingQuantity: line.expectedQuantity,
      expectedQuantity: line.expectedQuantity,
      expectedUnit: line.expectedUnit,
      replenishmentThreshold: resolveThreshold(line),
      lotNumber: line.lotNumber,
      expirationDate: line.expirationDate,
      isControlled: line.isControlled === true,
    };
  });
  return {
    deploymentId: envelope.deploymentId,
    drawdowns,
    deployedSignal: {
      deploymentId: envelope.deploymentId,
      patientId: envelope.patientId,
      admissionId: envelope.admissionId,
      contents: drawdowns.map((d) => ({
        medicationOrderId: d.medicationOrderId,
        expectedQuantity: d.expectedQuantity,
        expectedUnit: d.expectedUnit,
      })),
    },
  };
}

// ── Drawdown decrement + replenishment ──────────────────────────────────────────────────────────────────

/** §2.7 — the `m13.comfort_kit.replenishment_needed` payload (M21 forward seam consumes). */
export interface ReplenishmentSignal {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly drugName: string;
  readonly remainingQuantity: number;
  readonly remainingUnit: string;
  /** The amount needed to top the kit back to its deployed level (`expectedQuantity - remaining`). */
  readonly requestedQuantity: number;
  readonly lotNumber: string | null;
  readonly urgencyKind: "routine" | "urgent";
}

/** §2.7 — the current drawdown state the route reads before decrementing (server-resolved facts injected). */
export interface KitDrawdownState {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly remainingQuantity: number;
  readonly expectedQuantity: number;
  readonly expectedUnit: string;
  readonly replenishmentThreshold: number;
  readonly lotNumber: string | null;
  readonly drugName: string;
}

/** §2.7 — what one PRN administration draws from the kit: the dose plus any witnessed wastage. */
export interface KitDecrementInput {
  readonly administeredAmount: number;
  /** Wastage on a kit medication is subtracted from the drawdown (it was disposed). Default 0. */
  readonly wastageAmount?: number;
  /** PRN administrations of THIS order in the last 24h (drives the `urgent` burn-rate heuristic). */
  readonly recentPrnCount24h?: number;
}

/** §2.7 — the result of a drawdown decrement: the new remaining + the replenishment signal when at threshold. */
export interface KitDrawdownResult {
  readonly newRemainingQuantity: number;
  readonly belowThreshold: boolean;
  /** Present only when `belowThreshold` — the `m13.comfort_kit.replenishment_needed` payload to emit. */
  readonly replenishmentSignal: ReplenishmentSignal | null;
}

/**
 * §2.7 — compute the replenishment urgency: `urgent` when the remaining is at/below 10% of the deployed
 * amount OR the order has had ≥3 PRN administrations in the last 24h; `routine` otherwise. Pure.
 */
export function evaluateReplenishmentUrgency(
  remainingQuantity: number,
  expectedQuantity: number,
  recentPrnCount24h: number,
): "routine" | "urgent" {
  const lowStock = remainingQuantity <= expectedQuantity * URGENT_REPLENISHMENT_FRACTION;
  const burnRate = recentPrnCount24h >= URGENT_PRN_COUNT_24H;
  return lowStock || burnRate ? "urgent" : "routine";
}

/**
 * §2.7 D5 — decrement a kit drawdown by (administered + wastage) atomically with the administration commit.
 * If the decrement would drive `remaining_quantity` negative the administration is rejected with
 * `422 KIT_INSUFFICIENT_QUANTITY` (the kit count must reconcile). When the post-decrement remaining is at or
 * below the replenishment threshold, returns the `m13.comfort_kit.replenishment_needed` signal with the
 * computed urgency. Pure — no clock, no IO; the route persists the new remaining + emits the signal.
 */
export function applyKitDrawdown(
  state: KitDrawdownState,
  input: KitDecrementInput,
): KitDrawdownResult {
  const wastage = input.wastageAmount ?? 0;
  const drawn = input.administeredAmount + wastage;
  const newRemainingQuantity = state.remainingQuantity - drawn;
  if (newRemainingQuantity < 0) {
    throw new AdministrationStateError(
      "KIT_INSUFFICIENT_QUANTITY",
      `comfort-kit drawdown for order ${state.medicationOrderId} would go negative: ${state.remainingQuantity} on hand, ${drawn} requested`,
    );
  }
  const belowThreshold = newRemainingQuantity <= state.replenishmentThreshold;
  if (!belowThreshold) {
    return { newRemainingQuantity, belowThreshold: false, replenishmentSignal: null };
  }
  const urgencyKind = evaluateReplenishmentUrgency(
    newRemainingQuantity,
    state.expectedQuantity,
    input.recentPrnCount24h ?? 0,
  );
  return {
    newRemainingQuantity,
    belowThreshold: true,
    replenishmentSignal: {
      deploymentId: state.deploymentId,
      medicationOrderId: state.medicationOrderId,
      drugName: state.drugName,
      remainingQuantity: newRemainingQuantity,
      remainingUnit: state.expectedUnit,
      requestedQuantity: state.expectedQuantity - newRemainingQuantity,
      lotNumber: state.lotNumber,
      urgencyKind,
    },
  };
}

// ── Return + return reconciliation (consume `m21.comfort_kit.returned` / `.return_reconciliation`) ────────

/** §2.7 — the `m21.comfort_kit.returned` envelope (M21 fixture today). */
export interface ComfortKitReturnedEnvelope {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly returnedAt: IsoInstant;
}

/** §2.7 — the deployment patch + `m13.comfort_kit.returned` signal after a kit comes back. */
export interface ComfortKitReturnResult {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly disposalStatus: "returned";
  readonly returnedAt: IsoInstant;
}

/**
 * §2.7 — on `m21.comfort_kit.returned`, flip the deployment to `disposal_status='returned'` and stamp the
 * returned instant. Pure — the consumer persists the patch + emits `m13.comfort_kit.returned`.
 */
export function applyKitReturn(envelope: ComfortKitReturnedEnvelope): ComfortKitReturnResult {
  return {
    deploymentId: envelope.deploymentId,
    disposalStatus: "returned",
    returnedAt: envelope.returnedAt,
  };
}

/** §2.7 — one line of the `m21.comfort_kit.return_reconciliation` envelope: the staff-counted remaining. */
export interface KitReturnReconciliationLine {
  readonly medicationOrderId: MedicationOrderId;
  /** What M13's drawdown believed was left at return (the system's running remaining). */
  readonly trackedRemainingQuantity: number;
  /** What the returning supply staff physically counted. */
  readonly actualRemainingQuantity: number;
  readonly expectedQuantity: number;
  readonly isControlled: boolean;
}

/** §2.7 — the `m13.comfort_kit.controlled_substance_discrepancy` payload (≥5% controlled delta; M30/M36). */
export interface ControlledDiscrepancySignal {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly deltaQuantity: number;
  readonly deltaPercent: number;
}

/** §2.7 — the per-line reconciliation outcome: the column patch + any controlled-discrepancy signal. */
export interface KitReturnReconciliationResult {
  readonly medicationOrderId: MedicationOrderId;
  readonly finalRemainingQuantityAtReturn: number;
  readonly deltaQuantity: number;
  readonly deltaPercent: number;
  /** Present only when this is a controlled medication with a ≥5% delta — the survey-investigable signal. */
  readonly controlledDiscrepancySignal: ControlledDiscrepancySignal | null;
}

/**
 * §2.7 — reconcile one kit medication at return: record `final_remaining_quantity_at_return` and compute the
 * discrepancy between what M13 tracked and what was physically counted, as a fraction of the deployed amount.
 * For a controlled-substance line a discrepancy ≥5% of `expectedQuantity` surfaces the
 * `m13.comfort_kit.controlled_substance_discrepancy` signal. Pure — the consumer persists the patch + audits.
 */
export function reconcileKitReturnLine(
  deploymentId: ComfortKitDeploymentId,
  line: KitReturnReconciliationLine,
): KitReturnReconciliationResult {
  const deltaQuantity = line.trackedRemainingQuantity - line.actualRemainingQuantity;
  const absDelta = Math.abs(deltaQuantity);
  const deltaPercent = line.expectedQuantity > 0 ? absDelta / line.expectedQuantity : 0;
  const isReportable = line.isControlled && deltaPercent >= CONTROLLED_DISCREPANCY_FRACTION;
  return {
    medicationOrderId: line.medicationOrderId,
    finalRemainingQuantityAtReturn: line.actualRemainingQuantity,
    deltaQuantity,
    deltaPercent,
    controlledDiscrepancySignal: isReportable
      ? {
          deploymentId,
          medicationOrderId: line.medicationOrderId,
          deltaQuantity,
          deltaPercent,
        }
      : null,
  };
}
