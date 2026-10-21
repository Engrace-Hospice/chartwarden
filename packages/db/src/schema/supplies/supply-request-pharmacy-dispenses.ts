// @chartwarden/db — `supply_request_pharmacy_dispense` (M21, migration 0306, F-233 #248). The append-only fact
// "the order behind this request was dispensed at T", written by M21's consumer of
// `m12.medication_order.dispensed_at_pharmacy`. It is NOT a dispatch and never fabricates §1304 custody
// facts (see the migration header). `dispensing_pharmacy_mdm_id` is the order's pharmacy OF RECORD, not a
// vendor-confirmed dispensing pharmacy. `supply_request_id` is LOGICAL (the target is partitioned).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const supplyRequestPharmacyDispense = pgTable(
  "supply_request_pharmacy_dispense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** The outbox event id — the idempotency key. */
    sourceEventId: uuid("source_event_id").notNull(),
    source: text("source").$type<"dosespot">().notNull().default("dosespot"),
    outcome: text("outcome").$type<"recorded" | "no_correlating_request">().notNull(),
    outcomeReason: text("outcome_reason"),
    supplyRequestId: uuid("supply_request_id"),
    patientId: uuid("patient_id"),
    medicationOrderId: uuid("medication_order_id").notNull(),
    dosespotPrescriptionId: text("dosespot_prescription_id").notNull(),
    dispensedAt: timestamp("dispensed_at", { withTimezone: true }).notNull(),
    fillNumber: integer("fill_number"),
    /** The order's pharmacy OF RECORD (as M12 emitted it) — NOT a vendor-confirmed dispensing pharmacy. */
    dispensingPharmacyMdmId: uuid("dispensing_pharmacy_mdm_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventRequestUq: uniqueIndex("supply_request_pharmacy_dispense_event_request_uq")
      .on(t.organizationId, t.sourceEventId, t.supplyRequestId)
      .where(sql`${t.supplyRequestId} IS NOT NULL`),
    eventUnmatchedUq: uniqueIndex("supply_request_pharmacy_dispense_event_unmatched_uq")
      .on(t.organizationId, t.sourceEventId)
      .where(sql`${t.supplyRequestId} IS NULL`),
    requestIx: index("supply_request_pharmacy_dispense_request_ix")
      .on(t.organizationId, t.supplyRequestId)
      .where(sql`${t.supplyRequestId} IS NOT NULL`),
    patientIx: index("supply_request_pharmacy_dispense_patient_ix")
      .on(t.organizationId, t.patientId)
      .where(sql`${t.patientId} IS NOT NULL`),
  }),
);

export type SupplyRequestPharmacyDispenseRow = typeof supplyRequestPharmacyDispense.$inferSelect;
