// @wardenx/emar — the `m12.medication_order.discontinued` scheduled-dose cascade (F-166, #248). PURE,
// IO-free. The order-level counterpart to `discharge-cascade.ts`'s admission-level §2.5/§2.7 D14 plan:
// `discontinueOrder` (or the M11/M6 discharge cascades acting through it) flips ONE order to
// `discontinued`, and every future PENDING scheduled dose for THAT order — not the whole admission, which
// may carry other still-active orders — is stale the instant it stops. Reuses the identical "future
// pending only, never retroactive" rule `planDischargeCascade` already established: a past due-at dose
// either has a linked administration or the missed-dose sweep owns it, and retro-marking a dose "missed"
// after the fact creates a phantom compliance alert. Idempotent — re-running against the same
// already-cancelled doses yields an empty plan.
import type { IsoInstant, MedicationOrderId, ScheduledDoseId, ScheduledDoseStatus } from "@wardenx/types";

/** The minimal scheduled-dose facts the cascade reads (mirrors `CascadeScheduledDose`, order-scoped). */
export interface OrderCascadeScheduledDose {
  readonly scheduledDoseId: ScheduledDoseId;
  readonly dueAt: IsoInstant;
  readonly status: ScheduledDoseStatus;
}

/** The `m13.scheduled_dose.cancelled` payload for this cascade's one legal `cancellationReason` — a real,
 *  already-migrated `scheduled_dose_cancellation_reason` enum member distinct from the admission-level
 *  cascade's `admission_discharged`. */
export interface OrderScheduledDoseCancelledSignal {
  readonly scheduledDoseId: ScheduledDoseId;
  readonly medicationOrderId: MedicationOrderId;
  readonly cancellationReason: "order_discontinued";
  readonly sourceEventId: string;
}

/** The facts the worker resolves for the cascade (all injected; no IO). */
export interface OrderDiscontinueCascadeInput {
  readonly medicationOrderId: MedicationOrderId;
  /** The order's `discontinued_at` (or the upstream cascade's effective instant) — never a future dose
   *  strictly at-or-before this instant survives. */
  readonly effectiveAt: IsoInstant;
  /** The originating outbox event id, stamped onto each cancellation for provenance. */
  readonly sourceEventId: string;
  readonly scheduledDoses: readonly OrderCascadeScheduledDose[];
}

/** A scheduled dose is cancellable iff it is still pending AND its due instant is strictly future. */
function isCancellable(dose: OrderCascadeScheduledDose, effectiveAt: IsoInstant): boolean {
  return dose.status === "pending" && Date.parse(dose.dueAt) > Date.parse(effectiveAt);
}

/**
 * Plan the order-discontinue scheduled-dose cascade: cancel every still-pending dose for THIS order due
 * strictly after `effectiveAt`. Pure — no clock, no IO. The worker persists the cancellations + emits
 * `m13.scheduled_dose.cancelled` in one transaction, the identical write shape
 * `m6-admission-discharged-cascade.ts` already established for the admission-level plan.
 */
export function planOrderDiscontinueCascade(
  input: OrderDiscontinueCascadeInput,
): readonly OrderScheduledDoseCancelledSignal[] {
  return input.scheduledDoses.filter((dose) => isCancellable(dose, input.effectiveAt)).map((dose) => ({
    scheduledDoseId: dose.scheduledDoseId,
    medicationOrderId: input.medicationOrderId,
    cancellationReason: "order_discontinued",
    sourceEventId: input.sourceEventId,
  }));
}
