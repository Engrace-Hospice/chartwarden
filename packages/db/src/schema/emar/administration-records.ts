// @wardenx/db — `administration_record` (M13 §3.3). The central PHI table: one row per recorded
// medication administration (the §2.1 six modes via the discriminated `mode` + per-mode TypeBox-validated
// `data`; the §2.2 D6 committed→{pending_caregiver_review}→superseded/voided lifecycle). All clinician
// free-text either lives in a denylisted top-level column (notes / refusal_reason / caregiver_attestation_text
// / dispute_reason / administrative_override_reason / correction_reason / void_reason) or INSIDE the per-mode
// `data` jsonb (sig_free_text / infusionDilution / titrationReason / pauseReason / stopReason / wastageReason),
// so the audit trigger scrubs those top-level columns AND those nested `data` json-paths (§3.6 D12). PHI-bearing
// → the three-column tenancy rule (provider_entity_id + location_id NOT NULL, denormalized from the admission at
// commit, ARCH-011 / ADR-0010). High-volume + 10-year `compliance` retention → PARTITION BY RANGE
// (administered_at) monthly (§3.5 D13): the Drizzle definition is the logical shape (composite PK incl. the
// partition key); the PARTITION BY + monthly partitions land in the RLS migration (M13-T02). Cross-module refs
// (M5 patient, M6 admission, M12 medication_order — resolved through the seam, NEVER imported — M8 encounter,
// M9 assessment) are plain uuid app-validated, NOT cross-module FKs (M13 dependsOn [12,36,38]); administration_record
// is partitioned so every reference TO it (prn_administration / administration_witness / barcode_scan_event /
// offline-queue / self-ref corrects) carries NO single-column SQL FK, and PG cannot enforce a cross-partition
// unique without the partition key — the offline (device_id, local_id) idempotency is enforced at the app layer
// (M13-T09). Actor refs go to M1 `membership`. RLS + grants + the M4 write-audit trigger + the partition
// conversion land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  administrationActorKind,
  administrationLateEntryTier,
  administrationMode,
  administrationStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const administrationRecords = pgTable(
  "administration_record",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with administered_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)
    medicationOrderId: uuid("medication_order_id").notNull(), // M12 (resolved through seam; no FK)

    scheduledDoseId: uuid("scheduled_dose_id"), // M13 scheduled_dose (loose; no FK — see §3.3)
    prnAdministrationId: uuid("prn_administration_id"),
    encounterId: uuid("encounter_id"), // M8 encounter (app-validated; no cross-module FK)
    comfortKitDeploymentId: uuid("comfort_kit_deployment_id"),
    ivSessionId: uuid("iv_session_id"), // correlates an IV-continuous mode sequence

    mode: administrationMode("mode").notNull(),
    status: administrationStatus("status").notNull().default("committed"),

    // The discriminated body — per-mode TypeBox-validated; nested free-text json-paths denylisted (§3.6).
    data: jsonb("data").notNull(),

    // Snapshots denormalized at commit for read-path + survey-grade reconstruction.
    drugNameSnapshot: text("drug_name_snapshot").notNull(),
    rxnormRxcuiSnapshot: text("rxnorm_rxcui_snapshot"),
    routeSnapshot: text("route_snapshot").notNull(),
    doseAmountSnapshot: numeric("dose_amount_snapshot", { precision: 12, scale: 4 }),
    doseUnitSnapshot: text("dose_unit_snapshot"),
    isControlledSubstance: boolean("is_controlled_substance").notNull().default(false),
    isSudTreatment: boolean("is_sud_treatment").notNull().default(false),
    isComfortKitDrawdown: boolean("is_comfort_kit_drawdown").notNull().default(false),

    // Time semantics (D18). administered_at is the partition key.
    administeredAt: timestamp("administered_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),

    // Actor identity (D10).
    actorKind: administrationActorKind("actor_kind").notNull(),
    administeringClinicianMembershipId: uuid("administering_clinician_membership_id"), // null only for caregiver_attested
    actorCaregiverSessionId: uuid("actor_caregiver_session_id"),
    caregiverAttestationText: text("caregiver_attestation_text"), // DENYLISTED
    requiresRnReview: boolean("requires_rn_review").notNull().default(false),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    disputed: boolean("disputed").notNull().default(false),
    disputeReason: text("dispute_reason"), // DENYLISTED

    // Witness chain (D7).
    witnessMembershipId: uuid("witness_membership_id"),
    witnessAttestationTokenDigest: text("witness_attestation_token_digest"),
    witnessAttestedAt: timestamp("witness_attested_at", { withTimezone: true }),

    // Late entry tier (D8).
    lateEntryTier: administrationLateEntryTier("late_entry_tier").notNull().default("normal"),
    lateEntryReason: text("late_entry_reason"),
    significantLateOverrideBy: uuid("significant_late_override_by"),
    administrativeOverrideBy: uuid("administrative_override_by"),
    administrativeOverrideReason: text("administrative_override_reason"), // DENYLISTED

    // Refusal (the patient was offered the dose and declined).
    refused: boolean("refused").notNull().default(false),
    refusalReason: text("refusal_reason"), // DENYLISTED

    notes: text("notes"), // DENYLISTED

    // Offline capture (D18). Cross-partition uniqueness on (device_id, local_id) is enforced at the app layer.
    offlineCapture: boolean("offline_capture").notNull().default(false),
    deviceId: uuid("device_id"),
    localId: uuid("local_id"),

    // Correction lineage (D8).
    correctsAdministrationId: uuid("corrects_administration_id"),
    correctionReason: text("correction_reason"), // DENYLISTED

    // Void path.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"), // DENYLISTED

    documentId: uuid("document_id"), // M22 PDF back-ref

    // M37 IPU forward seam.
    pumpProgrammingVerifiedByMembershipId: uuid("pump_programming_verified_by_membership_id"),
    dispenseCabinetEventId: uuid("dispense_cabinet_event_id"),

    vocabVersionId: uuid("vocab_version_id"), // vocab pinning at write time

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.administeredAt] }), // partition key must be in the PK
    byPatientByTime: index("admin_rec_patient_time_idx").on(
      t.organizationId,
      t.patientId,
      t.administeredAt.desc(),
    ),
    byOrderByTime: index("admin_rec_order_time_idx").on(
      t.organizationId,
      t.medicationOrderId,
      t.administeredAt.desc(),
    ),
    byScheduledDose: index("admin_rec_scheduled_dose_idx")
      .on(t.scheduledDoseId)
      .where(sql`scheduled_dose_id IS NOT NULL`),
    byEncounter: index("admin_rec_encounter_idx")
      .on(t.encounterId)
      .where(sql`encounter_id IS NOT NULL`),
    byIvSession: index("admin_rec_iv_session_idx")
      .on(t.organizationId, t.ivSessionId, t.administeredAt.asc())
      .where(sql`iv_session_id IS NOT NULL`),
    pendingCaregiverReview: index("admin_rec_pending_caregiver_review_idx")
      .on(t.organizationId, t.requiresRnReview, t.recordedAt.desc())
      .where(sql`requires_rn_review = true`),
    // Cross-partition unique is illegal without the partition key; a plain partial index keeps the
    // offline-sync (device_id, local_id) lookup fast — uniqueness enforced at the app layer (M13-T09).
    offlineCapture: index("admin_rec_offline_capture_idx")
      .on(t.organizationId, t.deviceId, t.localId)
      .where(sql`offline_capture = true`),
    drugSnapshotRoute: index("admin_rec_drug_route_idx").on(t.rxnormRxcuiSnapshot, t.routeSnapshot),
  }),
);

export type AdministrationRecord = typeof administrationRecords.$inferSelect;
export type NewAdministrationRecord = typeof administrationRecords.$inferInsert;
