// apps/backend/src/modules/12-dosespot/consumers/admission-discharged-cascade.ts — the discharge-cascade
// auto-discontinue consumer (M12-T08, spec §4.5 / §2.2 D13). PHASE-1 PURE DECISION CORE.
//
// M6 emits `m6.admission.discharged` (death / revocation / transfer / live discharge). M12 subscribes: every
// active / queued / pending medication order on that admission is system-discontinued with
// `reason='admission_discharged'` and a null actor, the discharge event id stamped for provenance. The live
// consumer executes each discontinuation through M12's medication-order machine (`cascadeDiscontinue` event),
// which writes the discontinuation, flips status, audits, and publishes `m12.medication_order.discontinued` in
// one transaction. The consumed event name is a STRING literal only (no M6 schema import): M12 reads M6
// solely through the foundation outbox, never via a `dependsOn` edge (§4 boundary rule).
import type { MedicationOrderStatus } from "@chartwarden/types";

/** The `m6.admission.discharged` payload subset M12 reads (M6 owns the canonical wire shape). */
export interface AdmissionDischargedPayload {
  readonly admissionId: string;
  readonly organizationId: string;
  /** The outbox event id of the discharge — stamped into each discontinuation for provenance. */
  readonly dischargeEventId: string;
}

/** One medication order on the discharged admission, as the worker reads it (id + lifecycle status). */
export interface MedicationOrderOnAdmission {
  readonly orderId: string;
  readonly status: MedicationOrderStatus;
}

/** Everything the worker reads before deciding, surfaced as data so the decider stays pure. */
export interface MedicationDischargeCascadeFacts {
  readonly ordersOnAdmission: readonly MedicationOrderOnAdmission[];
}

/** A single per-order system discontinuation the worker executes through the `cascadeDiscontinue` event. */
export interface MedicationDischargeDiscontinueAction {
  readonly orderId: string;
  readonly reason: "admission_discharged";
  readonly actorMembershipId: null;
  readonly sourceOutboxEventId: string;
}

/** The full cascade plan: the per-order discontinuations + a count of terminal orders left alone. */
export interface MedicationDischargeCascadeAction {
  readonly discontinuations: readonly MedicationDischargeDiscontinueAction[];
  readonly skippedCount: number;
}

/** The §2.2 in-flight statuses the cascade discontinues (terminal/transient states are left untouched). */
const CASCADE_DISCONTINUABLE: ReadonlySet<MedicationOrderStatus> = new Set<MedicationOrderStatus>([
  "pending_signature",
  "verbal_pending",
  "queued_for_transmission",
  "active",
]);

/**
 * Decide the discharge cascade for an `m6.admission.discharged` delivery (pure). The worker resolves the
 * medication orders on the admission, then this returns one {@link MedicationDischargeDiscontinueAction} per
 * in-flight order; terminal orders are counted as skipped. Idempotent: a redelivery sees the already-
 * discontinued orders as terminal and skips them.
 */
export function decideMedicationDischargeCascade(
  payload: AdmissionDischargedPayload,
  facts: MedicationDischargeCascadeFacts,
): MedicationDischargeCascadeAction {
  const discontinuations: MedicationDischargeDiscontinueAction[] = [];
  let skippedCount = 0;
  for (const order of facts.ordersOnAdmission) {
    if (!CASCADE_DISCONTINUABLE.has(order.status)) {
      skippedCount += 1;
      continue;
    }
    discontinuations.push({
      orderId: order.orderId,
      reason: "admission_discharged",
      actorMembershipId: null,
      sourceOutboxEventId: payload.dischargeEventId,
    });
  }
  return { discontinuations, skippedCount };
}
