// apps/backend/src/modules/12-dosespot/webhooks/handlers.ts — the typed webhook handlers GAP-037 added next to the
// dispense handler in `./ingest.ts`: pharmacy ack / nack, the refill-request intake and the prescriber IAL2 status.
// Every handler runs inside the ingest transaction (so a receipt row never commits without its effect), returns a
// short PHI-free outcome string recorded on the receipt, and never invents a fact: an unknown prescription / prescriber
// id is recorded as `*_not_found`, never matched loosely.
//
// The INNER payload field names are our provisional wire mapping (`DOSESPOT_WIRE_MAPPING_VERIFIED = false`).
import { type DbClient, schema } from "@wardenx/db";
import type {
  DoseSpotRefillRequestPayload,
  DoseSpotScriptStatusUpdatePayload,
} from "@wardenx/dosespot";
import { and, eq } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import { applyPharmacyAck, applyPharmacyNack } from "../jobs/order-outcomes";

const MO = schema.medicationOrders;
const RR = schema.refillRequests;
const DP = schema.dosespotPrescribers;

/** `Sent` => ack (activates the order); `RxFillError` / `Rejected` => nack. */
export async function handleAckOrNack(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: {
    readonly organizationId: string;
    readonly update: DoseSpotScriptStatusUpdatePayload;
    readonly kind: "ack" | "nack";
    readonly at: Date;
  },
): Promise<string> {
  const [order] = await tx
    .select({ id: MO.id, status: MO.status, pharmacyMdmId: MO.dispensingPharmacyMdmId })
    .from(MO)
    .where(
      and(
        eq(MO.organizationId, input.organizationId),
        eq(MO.dosespotPrescriptionId, input.update.dosespot_prescription_id),
      ),
    )
    .limit(1);
  if (!order) return "order_not_found";
  // A script status can arrive for an order already settled by the poll (or out of order): a no-op, not an error.
  if (order.status !== "transmitted") return `${input.kind}_already_settled`;
  const applied =
    input.kind === "ack"
      ? await applyPharmacyAck(tx, outbox, {
          organizationId: input.organizationId,
          orderId: order.id,
          rawStatus: input.update.status,
          at: input.at,
        })
      : await applyPharmacyNack(tx, outbox, {
          organizationId: input.organizationId,
          orderId: order.id,
          rejectionReason: input.update.status,
          pharmacyMdmId: order.pharmacyMdmId ?? null,
          at: input.at,
        });
  return applied ? `${input.kind}_recorded` : `${input.kind}_already_settled`;
}

/** Open a pending `refill_request` for the order the pharmacy named (idempotent on the vendor event id). */
export async function handleRefillRequest(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: {
    readonly organizationId: string;
    readonly dosespotEventId: string;
    readonly refill: DoseSpotRefillRequestPayload;
    readonly receivedAt: Date;
  },
): Promise<string> {
  const [source] = await tx
    .select({
      id: MO.id,
      patientId: MO.patientId,
      providerEntityId: MO.providerEntityId,
      locationId: MO.locationId,
      pharmacyMdmId: MO.dispensingPharmacyMdmId,
    })
    .from(MO)
    .where(
      and(
        eq(MO.organizationId, input.organizationId),
        eq(MO.dosespotPrescriptionId, input.refill.dosespot_prescription_id),
      ),
    )
    .limit(1);
  if (!source) return "order_not_found";
  // `refill_request` carries the three-column tenancy anchor NOT NULL; an unanchored legacy order cannot own one.
  if (!source.providerEntityId || !source.locationId) return "order_unanchored";
  const rows = await tx
    .insert(RR)
    .values({
      organizationId: input.organizationId,
      providerEntityId: source.providerEntityId,
      locationId: source.locationId,
      sourceMedicationOrderId: source.id,
      patientId: source.patientId,
      dosespotEventId: input.dosespotEventId,
      pharmacyMdmId: source.pharmacyMdmId ?? null,
      pharmacyNcpdpAtReceipt: input.refill.pharmacy_ncpdp ?? null,
      requestedQuantity: input.refill.requested_quantity ?? null,
      requestedDaysSupply: input.refill.requested_days_supply ?? null,
      pharmacyNotes: input.refill.pharmacy_notes ?? null,
      receivedAt: input.receivedAt,
      status: "pending",
    })
    .onConflictDoNothing({ target: [RR.organizationId, RR.dosespotEventId] })
    .returning({ id: RR.id });
  const created = rows[0];
  if (!created) return "refill_duplicate";
  await outbox.publish(tx, {
    eventName: "m12.refill_request_received",
    organizationId: input.organizationId,
    aggregateKind: "refill_request",
    aggregateId: created.id,
    payload: {
      refillRequestId: created.id,
      sourceMedicationOrderId: source.id,
      patientId: source.patientId,
      receivedAt: input.receivedAt.toISOString(),
    },
  });
  return "refill_recorded";
}

/** Record a prescriber's IAL2 outcome; never turns EPCS ON (that stays an explicit, certified enablement). */
export async function handlePrescriberStatus(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly status: {
      readonly dosespot_prescriber_id: string;
      readonly ial2_status: "in_progress" | "verified" | "expired" | "revoked";
      readonly ial2_verified_at?: string;
      readonly ial2_expires_at?: string;
    };
    readonly at: Date;
  },
): Promise<string> {
  const s = input.status;
  const verifiedAt = s.ial2_verified_at ? new Date(s.ial2_verified_at) : null;
  const expiresAt = s.ial2_expires_at ? new Date(s.ial2_expires_at) : null;
  if (
    (verifiedAt && Number.isNaN(verifiedAt.getTime())) ||
    (expiresAt && Number.isNaN(expiresAt.getTime()))
  ) {
    return "malformed_payload";
  }
  if (s.ial2_status === "verified" && expiresAt === null) return "malformed_payload";
  const rows = await tx
    .update(DP)
    .set({
      ial2Status: s.ial2_status,
      ...(s.ial2_status === "verified"
        ? { ial2VerifiedAt: verifiedAt ?? input.at, ial2ExpiresAt: expiresAt, ial2AlertStage: null }
        : { epcsEnabled: false }),
      updatedAt: input.at,
    })
    .where(
      and(
        eq(DP.organizationId, input.organizationId),
        eq(DP.dosespotPrescriberId, s.dosespot_prescriber_id),
      ),
    )
    .returning({ id: DP.id });
  return rows.length === 1 ? "prescriber_status_recorded" : "prescriber_not_found";
}
