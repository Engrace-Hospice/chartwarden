import { sql } from "drizzle-orm";
// @wardenx/db — `intake_upload_batch` (M22 §3.3 / §2.2.5). The DocLens intake-batch aggregate: one
// row per uploaded bundle (fax/email/portal/admin/api), driving classify→extract→review→writeback.
//
// PHI-bearing by the three-column rule (it carries `patient_id`) → ARCH-011: the three tenancy
// columns are present. `patient_id` is nullable (a batch may arrive before the patient is resolved),
// so `provider_entity_id` / `location_id` are likewise nullable (the "org-level entity" carve-out).
// `source_metadata` is DENYLISTED in the audit trigger (§3.6 — may carry fax sender info). Cross-
// references (initial_document_id, child batch ids) are plain uuid app-validated; no SQL FK out.
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { intakeBatchStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const intakeUploadBatches = pgTable(
  "intake_upload_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // ARCH-011 three-column rule: nullable here (batch may arrive before patient resolution) — the
    // "org-level entity" carve-out for the field-service tenancy columns.
    patientId: uuid("patient_id"),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),

    initialDocumentId: uuid("initial_document_id").notNull(),
    sourceChannel: text("source_channel").notNull(), // fax|email_ingest|portal_upload|admin_upload|api
    sourceMetadata: text("source_metadata"), // DENYLISTED (§3.6) — may carry fax sender info
    status: intakeBatchStatus("status").notNull().default("uploaded"),
    childBatchIds: jsonb("child_batch_ids"), // uuid[] when status='split_into_children' (D10 / W3)
    auditMetadata: jsonb("audit_metadata"), // AI split-suggestion record retained for ML feedback (W3)
    uploadedByMembershipId: uuid("uploaded_by_membership_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    dispositionAt: timestamp("disposition_at", { withTimezone: true }),
  },
  (t) => ({
    byOrgPatient: index("intake_batch_org_patient_idx").on(t.organizationId, t.patientId),
    pendingReview: index("intake_batch_pending_review_idx")
      .on(t.organizationId)
      .where(sql`status IN ('extraction_complete','in_review')`),
    dispositionShape: check(
      "intake_upload_batch_disposition_shape",
      sql`(status IN ('writeback_complete','discarded')) = (disposition_at IS NOT NULL)`,
    ),
  }),
);

export type IntakeUploadBatch = typeof intakeUploadBatches.$inferSelect;
export type NewIntakeUploadBatch = typeof intakeUploadBatches.$inferInsert;
