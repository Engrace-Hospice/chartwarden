// @chartwarden/db — `admission_evidence` (M6 Phase 1 admission evidence). PHI-bearing: it carries
// patient/admission identifiers plus denormalized provider entity/location for the standard tenancy shape.
// Uploaded bytes remain owned by M22; this table pins the exact document_version that satisfied an M6
// requirement. Cross-module refs (M5 patient, M22 document/version) are app-validated UUIDs.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { admissions } from "./admissions";
import { electionPeriods } from "./election-periods";

export const admissionEvidence = pgTable(
  "admission_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    electionPeriodId: uuid("election_period_id").references(() => electionPeriods.id, {
      onDelete: "restrict",
    }),
    requirementType: text("requirement_type").notNull(),
    sourceType: text("source_type").notNull(),
    status: text("status").notNull().default("pending"),
    structuredEntityType: text("structured_entity_type"),
    structuredEntityId: uuid("structured_entity_id"),
    documentId: uuid("document_id"),
    documentVersionId: uuid("document_version_id"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeScopeIdx: uniqueIndex("admission_evidence_active_scope_uidx")
      .on(t.organizationId, t.admissionId, t.electionPeriodId, t.requirementType)
      .where(sql`status = 'valid' AND election_period_id IS NOT NULL`),
    activeAdmissionScopeIdx: uniqueIndex("admission_evidence_active_admission_scope_uidx")
      .on(t.organizationId, t.admissionId, t.requirementType)
      .where(sql`status = 'valid' AND election_period_id IS NULL`),
    admissionIdx: index("admission_evidence_admission_idx").on(
      t.organizationId,
      t.admissionId,
      t.requirementType,
      t.status,
    ),
    documentVersionIdx: index("admission_evidence_document_version_idx").on(
      t.organizationId,
      t.documentId,
      t.documentVersionId,
    ),
    requirementCheck: check(
      "admission_evidence_requirement_type_chk",
      sql`requirement_type IN ('notice_of_rights','election_statement','election_signature','cti','cti_signature')`,
    ),
    sourceCheck: check(
      "admission_evidence_source_type_chk",
      sql`source_type IN ('structured','uploaded')`,
    ),
    statusCheck: check(
      "admission_evidence_status_chk",
      sql`status IN ('pending','valid','invalid','superseded')`,
    ),
    structuredTypeCheck: check(
      "admission_evidence_structured_entity_type_chk",
      sql`structured_entity_type IS NULL OR structured_entity_type IN ('notice_of_rights','election_statement','cti')`,
    ),
    sourceIntegrity: check(
      "admission_evidence_source_integrity_chk",
      sql`(
        source_type = 'structured'
        AND structured_entity_type IS NOT NULL
        AND structured_entity_id IS NOT NULL
        AND document_id IS NULL
        AND document_version_id IS NULL
      ) OR (
        source_type = 'uploaded'
        AND structured_entity_type IS NULL
        AND structured_entity_id IS NULL
        AND document_id IS NOT NULL
        AND document_version_id IS NOT NULL
      )`,
    ),
  }),
);

export type AdmissionEvidence = typeof admissionEvidence.$inferSelect;
export type NewAdmissionEvidence = typeof admissionEvidence.$inferInsert;
