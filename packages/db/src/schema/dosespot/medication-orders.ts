// @wardenx/db — `medication_order` (M12 §3.3). The one root table for every DoseSpot-prescribed
// medication: the per-class TypeBox-validated payload in `data` (discriminated by `med_class`; all clinician
// free-text — sig_free_text / indication / clinical_justification / notes — lives INSIDE `data`, so the
// whole `data` jsonb is denylisted from the audit diff, §7.6), the §2.2 D2
// draft→pending_signature→{verbal_pending|epcs_identity_pending}→signed→queued_for_transmission→transmitted
// →ack_received/nack_received→active→completed/discontinued lifecycle, and the orthogonal §2.2/§4.10 DoseSpot
// NewRx-transmission observed state (`dosespot_send_state`). PHI-bearing → the three-column tenancy rule
// (provider_entity_id + location_id NOT NULL, denormalized from the admission at create-time, ARCH-011 /
// ADR-0010) so location/PE access checks + downstream Q-code/claim attribution run without joining M6.
// High-volume + retention-extended → PARTITION BY RANGE (created_at) monthly (§3.5, D15): the Drizzle
// definition is the logical shape (composite PK incl. the partition key); the actual PARTITION BY + monthly
// partitions land in the RLS migration (M12-T02). Cross-module refs (M5 patient, M6 admission, M40
// prescribing physician / dispensing pharmacy MDM) are plain uuid app-validated, NOT cross-module FKs (M12
// dependsOn [5,11,38,40]); medication_order is partitioned so self-ref `replaces_medication_order_id` carries
// NO single-column SQL FK; actor refs go to M1 `membership`. RLS + grants + the M4 write-audit trigger
// (`data` denylisted, §7.6) + the partition conversion land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { deaSchedule, dosespotSendState, medClass, medicationOrderStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const medicationOrders = pgTable(
  "medication_order",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with created_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0132 (M12L): createDraft carries only admission + med class; siting backfills
    // from the M6 admission / M17 visit context when threaded.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)

    // Classification.
    medClass: medClass("med_class").notNull(),
    isControlledSubstance: boolean("is_controlled_substance").notNull().default(false),
    deaSchedule: deaSchedule("dea_schedule"),
    isSudTreatment: boolean("is_sud_treatment").notNull().default(false),

    // Drug identity (M38 RxNorm/NDC are app-validated codes, not FKs).
    rxnormRxcui: text("rxnorm_rxcui"),
    ndc: text("ndc"),
    drugName: text("drug_name").notNull(),
    strength: text("strength").notNull(),
    doseForm: text("dose_form").notNull(),
    route: text("route").notNull(),

    data: jsonb("data").notNull(), // per-class TypeBox-validated; whole column denylisted (§7.6)

    // Prescriber + ordering/dispensing parties.
    prescriberMembershipId: uuid("prescriber_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    prescribingPhysicianMdmId: uuid("prescribing_physician_mdm_id").notNull(), // M40 (app-validated; no FK)
    dispensingPharmacyMdmId: uuid("dispensing_pharmacy_mdm_id"), // M40 (app-validated; no FK)

    refillsAuthorized: integer("refills_authorized").notNull().default(0),
    refillsRemaining: integer("refills_remaining").notNull().default(0),

    // Drug acquisition cost in integer CENTS (repo money rule — never fractional dollars), mig 0158.
    // NULL = "not priced" — the honest default until the DoseSpot fill/NDC pricing feed lands; a real
    // free/$0 line is an explicit 0, never NULL. Aggregates must REFUSE unpriced lines, not zero-fill
    // them (the §2.10 cost-basis seam feeds M27 Worksheet S-7; a fabricated $0 would corrupt it).
    acquisitionCostCents: integer("acquisition_cost_cents"),

    // Lifecycle.
    status: medicationOrderStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1), // optimistic concurrency

    // Orthogonal DoseSpot transmission state (§2.2 / §4.10).
    dosespotSendState: dosespotSendState("dosespot_send_state").notNull().default("not_required"),
    dosespotPrescriptionId: text("dosespot_prescription_id"),

    // Provenance links (all app-validated; no SQL FK — medication_order is partitioned).
    replacesMedicationOrderId: uuid("replaces_medication_order_id"), // self-ref correction chain
    derivedFromRefillId: uuid("derived_from_refill_id"), // refill_request mint
    derivedFromHistoryId: uuid("derived_from_history_id"), // medhx reconciliation carry-forward
    triggeringIdgDecisionId: uuid("triggering_idg_decision_id"), // M14 decision provenance

    // Cosign control.
    cosignRequired: boolean("cosign_required").notNull().default(false),
    cosignStatus: text("cosign_status"), // null when !cosignRequired

    // Document backref (M22 outbox handshake; null until rendered).
    documentId: uuid("document_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), // partition key + PK member
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    transmittedAt: timestamp("transmitted_at", { withTimezone: true }),
    ackReceivedAt: timestamp("ack_received_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    discontinuedAt: timestamp("discontinued_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }), // partition key must be in the PK
    byPatientStatus: index("medication_order_patient_status_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
    ),
    byAdmissionStatus: index("medication_order_admission_status_idx").on(
      t.organizationId,
      t.admissionId,
      t.status,
    ),
    byMedClassStatus: index("medication_order_med_class_status_idx").on(
      t.organizationId,
      t.medClass,
      t.status,
    ),
    byPrescriberPending: index("medication_order_prescriber_pending_idx")
      .on(t.organizationId, t.prescriberMembershipId, t.status)
      .where(sql`status IN ('pending_signature','verbal_pending','epcs_identity_pending')`),
    // Global uniqueness on dosespot_prescription_id cannot include only this column on a partitioned
    // table (PG requires the partition key in every unique index); enforced at the app/transmission layer
    // (mot_idempotency_unique). A plain partial index keeps the by-prescription lookup fast.
    byDosespotPrescriptionId: index("medication_order_dosespot_prescription_idx")
      .on(t.dosespotPrescriptionId)
      .where(sql`dosespot_prescription_id IS NOT NULL`),
    byTriggeringIdgDecision: index("medication_order_triggering_idg_decision_idx")
      .on(t.organizationId, t.triggeringIdgDecisionId)
      .where(sql`triggering_idg_decision_id IS NOT NULL`),
    byCreatedAt: index("medication_order_created_idx").on(t.createdAt),
    controlledScheduleConsistency: check(
      "medication_order_controlled_schedule_consistency",
      sql`(is_controlled_substance = true) = (dea_schedule IS NOT NULL)`,
    ),
    // Mirrors mig 0158's guarded CHECK (name differs from Drizzle's default so the migration owns it).
    acquisitionCostNonNegative: check(
      "medication_order_acquisition_cost_nonneg_chk",
      sql`acquisition_cost_cents IS NULL OR acquisition_cost_cents >= 0`,
    ),
  }),
);

export type MedicationOrder = typeof medicationOrders.$inferSelect;
export type NewMedicationOrder = typeof medicationOrders.$inferInsert;
