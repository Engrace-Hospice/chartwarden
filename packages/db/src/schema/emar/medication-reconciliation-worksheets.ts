// @wardenx/db — `medication_reconciliation_worksheet` (M13 §3.3 / §2.8 D17). One worksheet per admission per
// M6-triggered reconciliation event (admission / transfer_in / discharge / recertification): the trigger outbox
// event, the 5-day due, and the finalize lifecycle. PHI-bearing (patient_id) → the three-column tenancy rule
// (provider_entity_id + location_id NOT NULL). Non-partitioned (§3.5). Cross-module refs (M5 patient, M6 admission,
// the M6 trigger outbox event, M22 document) are plain uuid app-validated, NOT cross-module FKs. The unique on
// (admission, trigger_kind, trigger_outbox_event_id) makes re-deliveries idempotent no-ops. RLS + grants + the M4
// write-audit trigger land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { reconciliationTriggerKind, reconciliationWorksheetStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const medicationReconciliationWorksheets = pgTable(
  "medication_reconciliation_worksheet",
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

    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    triggerKind: reconciliationTriggerKind("trigger_kind").notNull(),
    triggerOutboxEventId: uuid("trigger_outbox_event_id").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(), // 5 calendar days from triggered_at for admission
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedByMembershipId: uuid("finalized_by_membership_id"),

    status: reconciliationWorksheetStatus("status").notNull().default("pending"),
    voidReason: text("void_reason"),

    documentId: uuid("document_id"), // M22 back-ref

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPatient: index("recon_ws_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.triggeredAt.desc(),
    ),
    pendingByDue: index("recon_ws_pending_due_idx")
      .on(t.dueAt.asc())
      .where(sql`status IN ('pending','in_progress')`),
    uniqueByAdmissionTrigger: uniqueIndex("recon_ws_admission_trigger_uk").on(
      t.organizationId,
      t.admissionId,
      t.triggerKind,
      t.triggerOutboxEventId,
    ),
  }),
);

export type MedicationReconciliationWorksheet =
  typeof medicationReconciliationWorksheets.$inferSelect;
export type NewMedicationReconciliationWorksheet =
  typeof medicationReconciliationWorksheets.$inferInsert;
