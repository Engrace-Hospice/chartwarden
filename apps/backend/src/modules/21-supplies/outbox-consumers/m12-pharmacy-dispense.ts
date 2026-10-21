// M21's live `m12.medication_order.dispensed_at_pharmacy` consumer (F-233, #248 — Option B of the F-230
// register).
//
// WHAT IT DOES: correlates the event to M21 requests by `data.contents[].medicationOrderId` (the ONLY link
// the spec defines; optional, absent for IPU floor stock) on `comfort_kit_deploy` / `comfort_kit_replenish`
// requests, and appends ONE `supply_request_pharmacy_dispense` row per correlated request: "dispensed at T,
// by the pharmacy mdm id of record, source dosespot".
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * It creates NO `comfort_kit_dispatch`. M21 §2.5 says it should, but that row's NOT NULL chain-of-custody
//     columns (kit serial, dispatcher, handling-policy digest, per-line lot/expiry) are facts about a physical
//     kit that a pharmacy-dispense signal does not carry. Inventing them would fabricate a DEA 21 CFR §1304
//     record. Dispatch creation stays with the real courier-leg/assembly capture.
//   * It changes no request status and no dispatch state machine, and does not touch `supply_request`.
//
// HONESTY OF THE PHARMACY FIELD: `dispensingPharmacyMdmId` on the event is the order's pharmacy OF RECORD
// (M12 maps no pharmacy identity off the webhook yet), not a vendor-confirmed dispensing pharmacy. It is
// stored as `dispensing_pharmacy_mdm_id` with exactly that meaning.
//
// SETTLEMENT: an event that correlates with no request is settled with one `no_correlating_request` row
// carrying the reason (visible, and a redelivery is a no-op). It is event-time correlation only.
//
// IDEMPOTENT on the outbox event id via the table's partial unique indexes (`ON CONFLICT DO NOTHING`), in
// addition to the dispatcher's own (eventId, consumerName) receipt. Event name is a STRING literal (no M12
// import, no new dependsOn edge). Runs with no acting membership (the F-102 `CONSUMER_USER_ID` convention).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

const REQUEST = schema.supplyRequest;
const FACT = schema.supplyRequestPharmacyDispense;

export const M12_DISPENSED_AT_PHARMACY_EVENT = "m12.medication_order.dispensed_at_pharmacy";
export const M21_PHARMACY_DISPENSE_CONSUMER_NAME = "m21.pharmacy-dispense-fact";

/** The reason recorded when no M21 request names the order (kept stable — tests and operators read it). */
export const NO_CORRELATING_REQUEST_REASON =
  "no comfort_kit_deploy/comfort_kit_replenish supply_request names this medicationOrderId in data.contents[]";

/** The `m12.medication_order.dispensed_at_pharmacy` shape M21 reads (M12 owns the canonical payload). */
interface DispensedAtPharmacyPayload {
  readonly orderId?: unknown;
  readonly dosespotPrescriptionId?: unknown;
  readonly dispensedAt?: unknown;
  readonly dispensingPharmacyMdmId?: unknown;
  readonly fillNumber?: unknown;
}

export interface M21PharmacyDispenseDeps {
  readonly db: DbClient;
}

export function buildM21PharmacyDispenseConsumer(
  deps: M21PharmacyDispenseDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M21_PHARMACY_DISPENSE_CONSUMER_NAME,
    consumerModule: "m21",
    eventTypes: [M12_DISPENSED_AT_PHARMACY_EVENT],
    async handle(event): Promise<void> {
      const p = (event.payload ?? {}) as DispensedAtPharmacyPayload;
      if (typeof p.orderId !== "string" || typeof p.dosespotPrescriptionId !== "string") {
        throw new Error(
          "m21.pharmacy-dispense-fact: payload has no orderId/dosespotPrescriptionId",
        );
      }
      const dispensedAt = typeof p.dispensedAt === "string" ? new Date(p.dispensedAt) : null;
      if (dispensedAt === null || Number.isNaN(dispensedAt.getTime())) {
        throw new Error("m21.pharmacy-dispense-fact: payload has no valid dispensedAt");
      }
      const orderId = p.orderId;
      const common = {
        organizationId: event.organizationId,
        sourceEventId: event.id,
        source: "dosespot" as const,
        medicationOrderId: orderId,
        dosespotPrescriptionId: p.dosespotPrescriptionId,
        dispensedAt,
        fillNumber: typeof p.fillNumber === "number" ? p.fillNumber : null,
        dispensingPharmacyMdmId:
          typeof p.dispensingPharmacyMdmId === "string" ? p.dispensingPharmacyMdmId : null,
      };

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const matches = await tx
            .select({ id: REQUEST.id, patientId: REQUEST.patientId })
            .from(REQUEST)
            .where(
              and(
                eq(REQUEST.organizationId, event.organizationId),
                inArray(REQUEST.kind, ["comfort_kit_deploy", "comfort_kit_replenish"]),
                sql`${REQUEST.data} -> 'contents' @> ${JSON.stringify([{ medicationOrderId: orderId }])}::jsonb`,
              ),
            );

          if (matches.length === 0) {
            await tx
              .insert(FACT)
              .values({
                ...common,
                outcome: "no_correlating_request",
                outcomeReason: NO_CORRELATING_REQUEST_REASON,
              })
              .onConflictDoNothing();
            return;
          }
          for (const m of matches) {
            await tx
              .insert(FACT)
              .values({
                ...common,
                outcome: "recorded",
                supplyRequestId: m.id,
                patientId: m.patientId,
              })
              .onConflictDoNothing();
          }
        },
      );
    },
  };
}
