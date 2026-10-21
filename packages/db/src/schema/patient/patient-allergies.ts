// @chartwarden/db — `patient_allergy` (M5; architecture §10.6.6 "Allergies → Module 5 → Allergy (linked to
// Patient)"; F-238, migration 0311). The patient's allergy / intolerance list. PHI-bearing → three-column
// tenancy rule, ENABLE+FORCE RLS, M4 write-audit trigger (`allergen_text`, `reaction`,
// `entered_in_error_reason` denylisted).
//
// LIFECYCLE. A DocLens-sourced row arrives `unverified` (source `intake_extraction`): a reviewer attested the
// line was on the referral fax, not that it is clinically true. A clinician moves it to `verified` or
// `entered_in_error`; nothing else changes the status and nothing ever deletes a row (survey trail).
// An `unverified` allergy is SHOWN to prescribers, labelled — hiding it would be the unsafe failure.
//
// `allergen_text` is the attested line VERBATIM (the reaction is part of it when the fax stated one);
// `reaction` / `severity` are only ever set by a clinician. `allergen_key` is the deterministic dedupe key
// (`doclensClinicalLineKey`, @chartwarden/types) — a second fax repeating an allergy is flagged, not duplicated.
// Provenance (`source_*`) points back at the M22 candidate / decision / review / document / page; plain
// uuids, no cross-module FK (M5 never imports M22 schema).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientAllergies = pgTable(
  "patient_allergy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    allergenText: text("allergen_text").notNull(), // DENYLISTED
    allergenKey: text("allergen_key").notNull(),
    reaction: text("reaction"), // DENYLISTED
    severity: text("severity").$type<"mild" | "moderate" | "severe" | "unknown">(),
    verificationStatus: text("verification_status")
      .$type<"unverified" | "verified" | "entered_in_error">()
      .notNull()
      .default("unverified"),
    source: text("source").$type<"intake_extraction" | "clinician_entry">().notNull(),
    sourceExtractionCandidateId: uuid("source_extraction_candidate_id"),
    sourceExtractionDecisionId: uuid("source_extraction_decision_id"),
    sourceExtractionCommitId: uuid("source_extraction_commit_id"),
    sourceDocumentId: uuid("source_document_id"),
    sourcePage: integer("source_page"),
    reportedByMembershipId: uuid("reported_by_membership_id").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    enteredInErrorByMembershipId: uuid("entered_in_error_by_membership_id"),
    enteredInErrorAt: timestamp("entered_in_error_at", { withTimezone: true }),
    enteredInErrorReason: text("entered_in_error_reason"), // DENYLISTED
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_allergy_patient_idx").on(t.organizationId, t.patientId),
    candidateUq: uniqueIndex("patient_allergy_source_candidate_uq")
      .on(t.organizationId, t.sourceExtractionCandidateId)
      .where(sql`source_extraction_candidate_id IS NOT NULL`),
    activeKeyUq: uniqueIndex("patient_allergy_active_key_uq")
      .on(t.organizationId, t.patientId, t.allergenKey)
      .where(sql`verification_status <> 'entered_in_error'`),
    statusChk: check(
      "patient_allergy_status_chk",
      sql`verification_status IN ('unverified', 'verified', 'entered_in_error')`,
    ),
    sourceChk: check(
      "patient_allergy_source_chk",
      sql`source IN ('intake_extraction', 'clinician_entry')`,
    ),
    severityChk: check(
      "patient_allergy_severity_chk",
      sql`severity IS NULL OR severity IN ('mild', 'moderate', 'severe', 'unknown')`,
    ),
  }),
);

export type PatientAllergy = typeof patientAllergies.$inferSelect;
export type NewPatientAllergy = typeof patientAllergies.$inferInsert;
