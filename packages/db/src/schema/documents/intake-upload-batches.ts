// @wardenx/db — `intake_upload_batch` (M22 §3.3 / §2.2.5). The multi-doc intake-pipeline aggregate: one row per
// uploaded batch driven through the uploaded→docling_complete→classifier_complete→…→writeback_complete machine
// (incl. the D10 fax-split states). PHI-bearing by the three-column rule (it carries `patient_id`) → ARCH-011:
// provider_entity_id + location_id are present (nullable — a raw fax/email batch may arrive before patient/
// provider/location context is resolved, matching the nullable `patient_id`). `source_metadata` may carry fax
// sender info → DENYLISTED in the §3.6 write-audit trigger. The disposition_at-shape invariant is a CHECK
// constraint. RLS + grants + the M4 write-audit trigger land in 0049.
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { intakeBatchStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const intakeUploadBatches = pgTable(
  "intake_upload_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // ARCH-011 three-column rule: PHI-bearing (carries patient_id). Nullable — a raw batch may arrive before
    // the patient/provider/location context is resolved.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id"), // M5 patient (app-validated; nullable until classified)
    initialDocumentId: uuid("initial_document_id").notNull(),
    sourceChannel: text("source_channel").notNull(), // fax|email_ingest|portal_upload|admin_upload|api
    sourceMetadata: text("source_metadata"), // may carry fax sender info → DENYLISTED (§3.6)
    status: intakeBatchStatus("status").notNull().default("uploaded"),
    childBatchIds: jsonb("child_batch_ids"), // uuid[] when status='split_into_children' (D10 / W3)
    auditMetadata: jsonb("audit_metadata"), // AI split-suggestion record retained for ML feedback (W3 AC)
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
