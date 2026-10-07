// apps/backend/src/modules/12-dosespot/jobs/order-outcomes.ts — the pharmacy-outcome transitions shared by the
// status-poll sweep and the webhook handler (GAP-037), so both settle an order IDENTICALLY and the loser of a race
// is a no-op. Each function runs inside the caller's org transaction, validates the edge with the §2.2 machine,
// updates BY ID guarded on `status = 'transmitted'` and asserts the row count, and publishes its events in the
// same transaction. They return `false` (nothing written, nothing emitted) when the order is no longer
// `transmitted` — already settled by the other path.
import { type DbClient, schema } from "@wardenx/db";
import { transitionMedicationOrder } from "@wardenx/dosespot";
import { and, eq, sql } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";

const MO = schema.medicationOrders;

export async function applyPharmacyAck(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: { organizationId: string; orderId: string; rawStatus: string; at: Date },
): Promise<boolean> {
  transitionMedicationOrder("transmitted", { type: "pharmacyAck", isSystemActor: true });
  transitionMedicationOrder("ack_received", {
    type: "activate",
    isSystemActor: true,
    transmissionRequired: true,
  });
  const rows = await tx
    .update(MO)
    .set({
      status: "active",
      dosespotSendState: "acked",
      ackReceivedAt: input.at,
      activatedAt: input.at,
      version: sql`${MO.version} + 2`,
      updatedAt: input.at,
    })
    .where(and(eq(MO.id, input.orderId), eq(MO.status, "transmitted")))
    .returning({ id: MO.id });
  if (rows.length !== 1) return false;
  const base = {
    organizationId: input.organizationId,
    aggregateKind: "medication_order",
    aggregateId: input.orderId,
  };
  await outbox.publish(tx, {
    ...base,
    eventName: "m12.medication_order.ack_received",
    payload: {
      orderId: input.orderId,
      ackedAt: input.at.toISOString(),
      scriptStatusFromDoseSpot: input.rawStatus,
    },
  });
  await outbox.publish(tx, {
    ...base,
    eventName: "m12.medication_order.active",
    payload: { orderId: input.orderId, fullDto: null },
  });
  return true;
}

export async function applyPharmacyNack(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: {
    organizationId: string;
    orderId: string;
    rejectionReason: string;
    pharmacyMdmId: string | null;
    at: Date;
  },
): Promise<boolean> {
  transitionMedicationOrder("transmitted", {
    type: "pharmacyNack",
    isSystemActor: true,
    rejectionReason: input.rejectionReason,
  });
  const rows = await tx
    .update(MO)
    .set({
      status: "nack_received",
      dosespotSendState: "nacked",
      version: sql`${MO.version} + 1`,
      updatedAt: input.at,
    })
    .where(and(eq(MO.id, input.orderId), eq(MO.status, "transmitted")))
    .returning({ id: MO.id });
  if (rows.length !== 1) return false;
  await outbox.publish(tx, {
    eventName: "m12.medication_order.nack_received",
    organizationId: input.organizationId,
    aggregateKind: "medication_order",
    aggregateId: input.orderId,
    payload: {
      orderId: input.orderId,
      nackedAt: input.at.toISOString(),
      rejectionReason: input.rejectionReason,
      dispensingPharmacyMdmId: input.pharmacyMdmId,
    },
  });
  return true;
}
