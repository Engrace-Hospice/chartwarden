// @wardenx/db — `mortality_review` (M30 §3.3; PARTITIONED monthly by `death_at`; retention class
// `phi`). The structured post-death review (clinical / satisfaction / compliance dimensions) created
// once per admission via an idempotent death event. Registers a §3.7 eraser (redact the free-text
// dimension members; retain the structured compliance record). ORG-SCOPED: organization_id NOT NULL
// (canonical app.org_id RLS). deceased_patient_id / admission_id are logical FKs (M5 / M6,
// app-validated). The free-text dimension members (clinical.freeTextNotes,
// satisfaction.caregiverQualitativeSummary, compliance.notes) are audit-denylisted (§3.6).
//
// PARTITION BY RANGE (death_at) monthly: the Drizzle definition is the LOGICAL shape (composite PK incl.
// the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land in the tables/RLS
// migration. The per-admission and per-idempotency-key UNIQUE constraints OMIT the partition key, so
// they cannot live on the partitioned PARENT — declared as plain non-unique indexes here and re-added
// as per-LEAF UNIQUE in the migration (the EVV `evv_event` precedent).
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import type {
  ClinicalDimensionData,
  ComplianceDimensionData,
  SatisfactionDimensionData,
} from "./types";

export const m30MortalityReviewStatus = pgEnum("m30_mortality_review_status", [
  "pending",
  "in_progress",
  "completed",
  "overdue",
]);

export const mortalityReview = pgTable(
  "mortality_review",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with death_at (partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    deceasedPatientId: uuid("deceased_patient_id").notNull(), // logical FK M5
    admissionId: uuid("admission_id").notNull(), // logical FK M6 (V-16)
    deathAt: timestamp("death_at", { withTimezone: true }).notNull(), // partition key
    status: m30MortalityReviewStatus("status").notNull().default("pending"),
    assignedReviewerMembershipId: uuid("assigned_reviewer_membership_id"),
    clinicalDimensionData: jsonb("clinical_dimension_data").$type<ClinicalDimensionData>(), // freeTextNotes DENYLISTED (§3.6)
    satisfactionDimensionData: jsonb(
      "satisfaction_dimension_data",
    ).$type<SatisfactionDimensionData>(), // caregiverQualitativeSummary DENYLISTED (§3.6)
    complianceDimensionData: jsonb("compliance_dimension_data").$type<ComplianceDimensionData>(), // notes DENYLISTED (§3.6)
    reviewerSignatureAt: timestamp("reviewer_signature_at", { withTimezone: true }),
    targetCompletionAt: timestamp("target_completion_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    linkedQapiProjectId: uuid("linked_qapi_project_id"),
    documentId: uuid("document_id"), // M22 back-ref
    createdViaEventIdempotencyKey: uuid("created_via_event_idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.deathAt] }), // partition key must be in the PK
    // uq_mortality_review_per_admission (admission_id) and uq_mortality_review_idem
    // (created_via_event_idempotency_key) OMIT the partition key (death_at), so they cannot be UNIQUE
    // on the partitioned PARENT — declared plain here; re-added as per-LEAF UNIQUE in the migration.
    byAdmission: index("idx_mortality_review_by_admission").on(t.admissionId),
    byIdemKey: index("idx_mortality_review_idem").on(t.createdViaEventIdempotencyKey),
  }),
);

export type MortalityReview = typeof mortalityReview.$inferSelect;
export type NewMortalityReview = typeof mortalityReview.$inferInsert;
