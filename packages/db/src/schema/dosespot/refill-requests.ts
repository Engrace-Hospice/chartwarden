// @wardenx/db — `refill_request` (M12 §3.3 / §2.7 D9). One row per pharmacy-initiated refill request that
// arrives via the DoseSpot `refill_request` webhook: the source order it renews, the pharmacy of record at
// receipt, the requested quantity/days-supply, and the §2.7 approve/deny inbox workflow (approve mints a new
// `medication_order` via `resulting_medication_order_id`; deny records a channel + reason). PHI-bearing
// (patient_id) → the three-column tenancy rule (provider_entity_id + location_id NOT NULL, denormalized from
// the source order at receipt-time, ARCH-011 / ADR-0010). Non-partitioned. `source_medication_order_id` and
// `resulting_medication_order_id` are plain uuid with NO SQL FK (medication_order is partitioned); patient_id
// (M5) / pharmacy_mdm_id (M40) are plain uuid app-validated; actor refs go to M1 `membership`. `pharmacy_notes`
// + `denial_reason` are denylisted from the audit diff (§7.6). The (organization_id, dosespot_event_id)
// unique index gives webhook idempotency (re-delivery is a no-op). RLS + grants + the M4 write-audit trigger
// land in the RLS migration (M12-T02).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { refillRequestStatus, refillResponseChannel } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const refillRequests = pgTable(
  "refill_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    sourceMedicationOrderId: uuid("source_medication_order_id").notNull(), // M12 partitioned parent → no FK
    patientId: uuid("patient_id").notNull(), // M5 (app-validated; no cross-module FK)

    dosespotEventId: text("dosespot_event_id").notNull(), // dedup / idempotency
    pharmacyMdmId: uuid("pharmacy_mdm_id"), // M40 (app-validated; no FK)
    pharmacyNcpdpAtReceipt: text("pharmacy_ncpdp_at_receipt"),
    requestedQuantity: text("requested_quantity"),
    requestedDaysSupply: integer("requested_days_supply"),
    pharmacyNotes: text("pharmacy_notes"), // denylisted (§7.6)

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    status: refillRequestStatus("status").notNull().default("pending"),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByMembershipId: uuid("approved_by_membership_id").references(() => memberships.id),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deniedByMembershipId: uuid("denied_by_membership_id").references(() => memberships.id),
    denialReason: text("denial_reason"), // denylisted (§7.6)

    resultingMedicationOrderId: uuid("resulting_medication_order_id"), // minted order (app-validated; no FK)
    responseChannel: refillResponseChannel("response_channel"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupUnique: uniqueIndex("refill_request_dosespot_event_unique").on(
      t.organizationId,
      t.dosespotEventId,
    ),
    byPendingSla: index("refill_request_pending_sla_idx")
      .on(t.organizationId, t.receivedAt)
      .where(sql`status = 'pending'`),
  }),
);

export type RefillRequest = typeof refillRequests.$inferSelect;
export type NewRefillRequest = typeof refillRequests.$inferInsert;
