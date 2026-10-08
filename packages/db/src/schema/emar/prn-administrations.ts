// @wardenx/db — `prn_administration` (M13 §3.3 / §2.4 D3). 1:1 wrapper carrying the PRN-specific fields for a
// PRN administration_record: the triggering reason, the effectiveness-reassessment window M9 reads via
// `triggering_prn_administration_id` linkage. PHI-bearing (patient_id) → the three-column tenancy rule
// (provider_entity_id + location_id NOT NULL). Non-partitioned (1:1 with administration rows, §3.5).
// administration_record is partitioned, so `administration_record_id` is plain uuid (no SQL FK); the 1:1 is
// enforced by a unique index on this non-partitioned table. Cross-module refs (M5 patient, M6 admission, M12
// medication_order, M9 assessment) are plain uuid app-validated, NOT cross-module FKs. RLS + grants + the M4
// write-audit trigger (triggering_prn_reason / prn_interval_override_reason denylisted, §3.6) land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { prnRequestedByKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const prnAdministrations = pgTable(
  "prn_administration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Nullable (mig 0640): an ad-hoc PRN dose names no scheduled dose and so has no siting to copy; this
    // mirrors `administration_record` (mig 0133), whose row this one wraps.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    administrationRecordId: uuid("administration_record_id").notNull(), // 1:1 with administration_record (no FK — partitioned)

    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    medicationOrderId: uuid("medication_order_id").notNull(),

    triggeringPrnReason: text("triggering_prn_reason").notNull(), // DENYLISTED
    requestedByKind: prnRequestedByKind("requested_by_kind").notNull(),
    triggeringAssessmentId: uuid("triggering_assessment_id"), // M9 clinical scale (app-validated; no FK)

    reassessmentWindowMinutes: integer("reassessment_window_minutes").notNull(),
    reassessmentDueAt: timestamp("reassessment_due_at", { withTimezone: true }).notNull(),
    recommendedReassessmentScale: text("recommended_reassessment_scale"), // e.g. 'esas_r', 'painad'

    prnIntervalOverride: boolean("prn_interval_override").notNull().default(false),
    prnIntervalOverrideReason: text("prn_interval_override_reason"), // DENYLISTED
    prnIntervalOverrideBy: uuid("prn_interval_override_by"),

    // "Already warned" marker (0345): the overdue check was resolved (event published or reassessment captured).
    reassessmentOverdueWarnedAt: timestamp("reassessment_overdue_warned_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAdmin: uniqueIndex("prn_admin_record_uk").on(t.administrationRecordId),
    byPatientByTime: index("prn_admin_patient_time_idx").on(
      t.organizationId,
      t.patientId,
      t.createdAt.desc(),
    ),
    byOrderByTime: index("prn_admin_order_time_idx").on(
      t.organizationId,
      t.medicationOrderId,
      t.createdAt.desc(),
    ),
    reassessmentDue: index("prn_admin_reassessment_due_idx").on(t.reassessmentDueAt.asc()),
  }),
);

export type PrnAdministration = typeof prnAdministrations.$inferSelect;
export type NewPrnAdministration = typeof prnAdministrations.$inferInsert;
