// @wardenx/db — `clinical_assessment` (M9 §3.3, D1). The shared base table for all 14 validated
// scales (PPS/KPS/FAST/PAINAD/FLACC/ESAS-r/NYHA/MELD/BODE/Flacker/GDS/Braden/Morse/AIMS): one row per
// measurement, the per-scale shape carried in the `data` jsonb (validated by the per-scale TypeBox +
// scoring module under `packages/assessments/src/scales/<scale>`), the score server-computed (D6).
// PHI-bearing → the three-column tenancy rule; provider_entity_id + location_id are NOT NULL,
// denormalized from the admission at record-time (§3.3 tenancy note). Cross-module refs (M5 patient,
// M6 admission, M8 source_encounter — FK deferred to M8 land per D5, M39 acting_consent) are plain
// uuid app-validated, NOT cross-module FKs; actor refs go to M1 `membership`. High-volume → PARTITION
// BY RANGE (captured_at) monthly (D11): the Drizzle definition is the logical shape (composite PK incl.
// the partition key); the actual PARTITION BY + monthly partitions + the DEFERRABLE self-FK
// (corrects_assessment_id) + the correction-supersede trigger are emitted by the migration
// (§3.4/§3.6, M9-T02). Append-only — a correction inserts a new row and flips the prior to superseded
// (D9). RLS + grants + the M4 write-audit trigger land in the RLS migration alongside the conversion.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { scaleType, assessmentStatus, assessmentActingAs } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const clinicalAssessments = pgTable(
  "clinical_assessment",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with captured_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0129 (M9L): the record route carries only patient+admission+scale; siting
    // backfills from the M6 admission / M17 visit context when threaded.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (logical; not enforced cross-module)

    scaleType: scaleType("scale_type").notNull(),
    scaleVersion: text("scale_version").notNull(), // e.g. 'pps_v2_2001'
    data: jsonb("data").notNull(), // discriminated-union per-scale payload (free-text denylisted from audit)
    score: numeric("score", { precision: 8, scale: 2 }), // null where the scale is non-numeric (D6)
    scoreInterpretation: text("score_interpretation"),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(), // partition key + PK member
    capturedByMembershipId: uuid("captured_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    capturedByDiscipline: text("captured_by_discipline").notNull(),

    sourceEncounterId: uuid("source_encounter_id"), // M8 encounter (logical; FK deferred until M8 lands, D5)
    cosignRequired: boolean("cosign_required").notNull().default(false),
    sudContext: boolean("sud_context").notNull().default(false),
    actingConsentId: uuid("acting_consent_id"), // M39 consent (logical; M39 may erase the consent, retain the ref)
    actingAs: assessmentActingAs("acting_as").notNull().default("self"),

    status: assessmentStatus("status").notNull().default("active"),
    correctsAssessmentId: uuid("corrects_assessment_id"), // self-ref; DEFERRABLE composite FK added in migration
    correctionReason: text("correction_reason"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.capturedAt] }), // partition key must be in the PK
    // The trend lookup hot path (latest/series). Partial — only active rows participate.
    patientScaleCapturedIdx: index("clinical_assessment_patient_scale_captured_idx")
      .on(t.organizationId, t.patientId, t.scaleType, t.capturedAt.desc())
      .where(sql`status = 'active'`),
    // Encounter join for the M8 forward read.
    sourceEncounterIdx: index("clinical_assessment_source_encounter_idx")
      .on(t.sourceEncounterId)
      .where(sql`source_encounter_id is not null`),
    admissionIdx: index("clinical_assessment_admission_idx").on(
      t.organizationId,
      t.admissionId,
      t.capturedAt.desc(),
    ),
    correctionConsistency: check(
      "correction_consistency",
      sql`(corrects_assessment_id IS NULL AND correction_reason IS NULL)
          OR (corrects_assessment_id IS NOT NULL AND correction_reason IS NOT NULL
              AND char_length(correction_reason) >= 10)`,
    ),
  }),
);

export type ClinicalAssessment = typeof clinicalAssessments.$inferSelect;
export type NewClinicalAssessment = typeof clinicalAssessments.$inferInsert;
