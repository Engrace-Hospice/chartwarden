// @wardenx/db — the four M12 DoseSpot vendor-boundary persistence tables (F-230, #248; migration 0303).
// Populated ONLY by a real ingested vendor payload (a successful upsert response, a MedHx pull result, a
// signature-verified ScriptStatusUpdate webhook) — never seeded, never defaulted.
//   • dosespot_patient_sync      — §2.6 patient -> DoseSpot-side patient id (the id a MedHx pull is keyed on).
//   • medication_history_pull    — one ledger row per ingested MedHx pull: distinguishes "pulled, zero entries"
//                                  from "never pulled" (M12 §5.5 / M14 packet 'no external history' state).
//   • medication_history_record  — §2.8 one row per external MedHx entry (PHI; never auto-linked to an order).
//   • medication_order_dispense  — §4.4 one row per Dispensed/PickedUp ScriptStatusUpdate webhook.
// `patient_id` / `medication_order_id` are plain uuid with no cross-module/partitioned FK (the
// `dosespot_sync_queue` / `medication_order_transmission` precedent).
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { dosespotWebhookEvents } from "./dosespot-webhook-events";

export const dosespotPatientSync = pgTable(
  "dosespot_patient_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 (app-validated; no cross-module FK)
    lastDosespotPatientId: text("last_dosespot_patient_id"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncOutcome: text("last_sync_outcome").$type<"success" | "failed">().notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    lastErrorClass: text("last_error_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientUq: uniqueIndex("dosespot_patient_sync_patient_uq").on(t.organizationId, t.patientId),
  }),
);

export const medicationHistoryPulls = pgTable(
  "medication_history_pull",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    source: text("source").$type<"dosespot_medhx">().notNull().default("dosespot_medhx"),
    sourceJobId: uuid("source_job_id").notNull(), // the dosespot_sync_queue row id
    dosespotPatientId: text("dosespot_patient_id").notNull(),
    totalReturned: integer("total_returned").notNull(),
    rowsCreated: integer("rows_created").notNull(),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobUq: uniqueIndex("medication_history_pull_job_uq").on(t.organizationId, t.sourceJobId),
  }),
);

export const medicationHistoryRecords = pgTable(
  "medication_history_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    // F-238 (0311): NOT NULL only for `dosespot_medhx` (the `medication_history_record_source_shape_chk`
    // CHECK); a `doclens_intake` line has no MedHx pull — its provenance is the `source_extraction_*` set.
    pullId: uuid("pull_id").references(() => medicationHistoryPulls.id, { onDelete: "restrict" }),
    source: text("source")
      .$type<"dosespot_medhx" | "doclens_intake">()
      .notNull()
      .default("dosespot_medhx"),
    sourceEventId: uuid("source_event_id"),
    lineIndex: integer("line_index").notNull(),
    rxnormRxcui: text("rxnorm_rxcui"),
    ndc: text("ndc"),
    drugName: text("drug_name").notNull(), // audit-denylisted
    strength: text("strength"),
    doseForm: text("dose_form"),
    sigText: text("sig_text"), // audit-denylisted
    prescribedAt: timestamp("prescribed_at", { withTimezone: true }),
    lastFillDate: text("last_fill_date"),
    fillDates: jsonb("fill_dates").$type<string[]>().notNull().default([]),
    sourcePharmacy: text("source_pharmacy"),
    pharmacyNcpdp: text("pharmacy_ncpdp"),
    prescriberNpi: text("prescriber_npi"),
    // ── F-238 (0311) — DocLens intake provenance + the D10 reconciliation decision ─────────────────────
    // A `doclens_intake` row is a referral-fax medication line AS THE REVIEWER ATTESTED IT, verbatim in
    // `drug_name` (never parsed; strength/dose_form/sig/rxnorm stay NULL). Plain uuids — M12 never imports
    // M22 schema. `line_key` is the deterministic dedupe key (`doclensClinicalLineKey`).
    sourceExtractionCandidateId: uuid("source_extraction_candidate_id"),
    sourceExtractionDecisionId: uuid("source_extraction_decision_id"),
    sourceDocumentId: uuid("source_document_id"),
    sourcePage: integer("source_page"),
    attestedByMembershipId: uuid("attested_by_membership_id"),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    lineKey: text("line_key"),
    reconciliationDecision: text("reconciliation_decision").$type<
      "carry_forward" | "discontinue" | "document_only"
    >(),
    reconciledByMembershipId: uuid("reconciled_by_membership_id"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineUq: uniqueIndex("medication_history_record_line_uq").on(
      t.organizationId,
      t.pullId,
      t.lineIndex,
    ),
    candidateUq: uniqueIndex("medication_history_record_source_candidate_uq")
      .on(t.organizationId, t.sourceExtractionCandidateId)
      .where(sql`source_extraction_candidate_id IS NOT NULL`),
    doclensKeyUq: uniqueIndex("medication_history_record_doclens_key_uq")
      .on(t.organizationId, t.patientId, t.lineKey)
      .where(sql`source = 'doclens_intake'`),
  }),
);

export const medicationOrderDispenses = pgTable(
  "medication_order_dispense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    medicationOrderId: uuid("medication_order_id").notNull(), // partitioned parent → no single-col FK
    dosespotPrescriptionId: text("dosespot_prescription_id").notNull(),
    webhookEventId: uuid("webhook_event_id")
      .notNull()
      .references(() => dosespotWebhookEvents.id, { onDelete: "restrict" }),
    dosespotEventId: text("dosespot_event_id").notNull(),
    scriptStatus: text("script_status").$type<"Dispensed" | "PickedUp">().notNull(),
    dispensedAt: timestamp("dispensed_at", { withTimezone: true }).notNull(),
    fillNumber: integer("fill_number"),
    dispensingPharmacyMdmId: uuid("dispensing_pharmacy_mdm_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventUq: uniqueIndex("medication_order_dispense_event_uq").on(
      t.organizationId,
      t.dosespotEventId,
    ),
  }),
);

export type DosespotPatientSyncRow = typeof dosespotPatientSync.$inferSelect;
export type MedicationHistoryPullRow = typeof medicationHistoryPulls.$inferSelect;
export type MedicationHistoryRecordRow = typeof medicationHistoryRecords.$inferSelect;
export type MedicationOrderDispenseRow = typeof medicationOrderDispenses.$inferSelect;
