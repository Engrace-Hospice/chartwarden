// apps/backend/src/modules/12-dosespot/prescription-id.ts — the one guard on recording a DoseSpot prescription id on an order.
//
// DoseSpot webhooks (a script-status update, a refill request, a dispense) bind to an order by `medication_order.dosespot_prescription_id`
// and take the first match (webhooks/handlers.ts, webhooks/ingest.ts). If two orders carried the same id, an event for one patient's
// prescription could land on another patient's order. The column cannot be unique (the table is partitioned by created_at, so PostgreSQL
// would need the partition key in the index), so the rule lives here: the writers that record an id (the transmit worker's success and an
// administrator's "sent" resolution) take a per-(organization, id) advisory lock for the rest of their transaction, then check that no OTHER
// order of the organization already carries it. The lock makes check-then-write atomic between those writers.
//
// LOCK ORDER: the advisory lock first, the order row after. Every caller follows it, so two writers of the same id cannot deadlock.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, ne, sql } from "drizzle-orm";

const MO = schema.medicationOrders;

/** Take the advisory lock for `(organizationId, prescriptionId)` until the transaction ends. Take it BEFORE any order row lock. */
export async function lockPrescriptionId(
  tx: DbClient,
  organizationId: string,
  prescriptionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId} || ':' || ${prescriptionId}, 0))`,
  );
}

/** Does ANOTHER order of the organization already carry `prescriptionId`? (Call it holding {@link lockPrescriptionId}.) */
export async function isPrescriptionIdTaken(
  tx: DbClient,
  organizationId: string,
  prescriptionId: string,
  orderId: string,
): Promise<boolean> {
  const [other] = await tx
    .select({ id: MO.id })
    .from(MO)
    .where(
      and(
        eq(MO.organizationId, organizationId),
        eq(MO.dosespotPrescriptionId, prescriptionId),
        ne(MO.id, orderId),
      ),
    )
    .limit(1);
  return other !== undefined;
}

/** Lock, then check, in one call: `true` means refuse (409 DOSESPOT_PRESCRIPTION_ID_IN_USE) or hold the order; `false` means free to record. */
export async function prescriptionIdTakenByAnotherOrder(
  tx: DbClient,
  organizationId: string,
  prescriptionId: string,
  orderId: string,
): Promise<boolean> {
  await lockPrescriptionId(tx, organizationId, prescriptionId);
  return isPrescriptionIdTaken(tx, organizationId, prescriptionId, orderId);
}
