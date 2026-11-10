// apps/backend/src/modules/12-dosespot/transmission-enqueue.ts — the sign-time enqueue (GAP-037, spec §5.1 W-MR-01).
//
// A signed order whose tenant has a BOUND DoseSpot adapter and that CAN be e-prescribed (an RxCUI and a structured
// sig) is queued for transmission INSTEAD of being activated locally: the D8 idempotency key is computed, the
// `medication_order_transmission` row is inserted (first-call-wins on `(organization_id, idempotency_key)`, and the key names the ORDER, so a
// double-sign of the same order re-uses its row while a replacement order gets its own), the order moves to `queued_for_transmission` / `dosespot_send_state='queued'`
// and `m12.medication_order.queued_for_transmission` is published, all in the caller's transaction. Returns `false`
// (touching nothing) when the order is not transmittable, so the F-058 local activation runs unchanged.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  computeNewRxIdempotencyKey,
  computeRxBusinessKey,
  planTransmissionEnqueue,
  sigDirections,
  transitionMedicationOrder,
} from "@chartwarden/dosespot";
import { and, eq } from "drizzle-orm";

/** Structural twin of `DoseSpotWriteOutboxPort` (declared here so this file does not import the service that imports it). */
interface EnqueueOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;

export async function enqueueTransmissionIfBound(
  tx: DbClient,
  outbox: EnqueueOutboxPort,
  organizationId: string,
  row: typeof MO.$inferSelect,
  at: Date,
): Promise<boolean> {
  if (row.dosespotSendState !== "not_required") return false;
  const sig = (row.data as Record<string, unknown> | null)?.sigStructured;
  if (!row.rxnormRxcui || typeof sig !== "object" || sig === null) return false;
  const rxBusinessKey = computeRxBusinessKey({
    rxnormRxcui: row.rxnormRxcui,
    strength: row.strength,
    sigFreeText: sigDirections(sig as Record<string, unknown>),
  });
  const idempotencyKey = computeNewRxIdempotencyKey({
    prescriberMembershipId: row.prescriberMembershipId,
    patientId: row.patientId,
    rxBusinessKey,
    medicationOrderId: row.id,
  });
  transitionMedicationOrder("signed", { type: "enqueueTransmission", isSystemActor: true });
  const plan = planTransmissionEnqueue({
    medicationOrderId: row.id,
    idempotencyKey,
    rxBusinessKey,
    correlationId: randomUUID(),
  });
  // The order's own row first, whatever key it carries now: a registration move replaces a waiting transmission's key, and a second sign that read the
  // order before the first committed (the sign path reads it without a lock) would otherwise find no row under the deterministic key it computes and
  // insert a second one for the same order. The unique index on the key still serialises two signs that both find none.
  const [ofThisOrder] = await tx
    .select({ id: MOT.id })
    .from(MOT)
    .where(and(eq(MOT.organizationId, organizationId), eq(MOT.medicationOrderId, row.id)))
    .limit(1);
  const inserted =
    ofThisOrder === undefined
      ? await tx
          .insert(MOT)
          .values({ organizationId, ...plan.insert })
          .onConflictDoNothing()
          .returning({ id: MOT.id })
      : [];
  let transmissionId = ofThisOrder?.id ?? inserted[0]?.id;
  if (transmissionId === undefined) {
    const [existing] = await tx
      .select({ id: MOT.id, medicationOrderId: MOT.medicationOrderId })
      .from(MOT)
      .where(and(eq(MOT.organizationId, organizationId), eq(MOT.idempotencyKey, idempotencyKey)))
      .limit(1);
    // the key names this order, so a row under it is this order's (a racing second sign). A row that is another order's would leave this one
    // queued with no row of its own, which the worker never picks up: refuse loudly instead of queuing it.
    if (existing !== undefined && existing.medicationOrderId !== row.id) {
      throw new Error("transmission row under this idempotency key belongs to another order");
    }
    transmissionId = existing?.id;
  }
  if (transmissionId === undefined) throw new Error("transmission row missing after enqueue");
  // Matched by ID (the partition-key timestamp round-trips lossily) with the row count asserted.
  const updated = await tx
    .update(MO)
    .set({
      status: plan.status,
      dosespotSendState: plan.sendState,
      version: row.version + 2,
      updatedAt: at,
    })
    .where(eq(MO.id, row.id))
    .returning({ id: MO.id });
  if (updated.length !== 1) throw new Error("medication_order not updated at enqueue");
  await outbox.publish(tx, {
    eventName: plan.event,
    organizationId,
    aggregateKind: "medication_order",
    aggregateId: row.id,
    payload: { orderId: row.id, transmissionId, idempotencyKey },
  });
  return true;
}
