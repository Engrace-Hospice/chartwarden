import { sql } from "drizzle-orm";
// @chartwarden/db — `intake_upload_batch` (M22 §3.3 / §2.2.5). The DocLens intake-batch aggregate: one
// row per uploaded bundle (fax/email/portal/admin/api), driving classify→extract→review→writeback.
//
// PHI-bearing by the three-column rule (it carries `patient_id`) → ARCH-011: the three tenancy
// columns are present. `patient_id` is nullable (a batch may arrive before the patient is resolved),
// so `provider_entity_id` / `location_id` are likewise nullable (the "org-level entity" carve-out).
// `source_metadata` is DENYLISTED in the audit trigger (§3.6 — may carry fax sender info). Cross-
// references (initial_document_id, child batch ids) are plain uuid app-validated; no SQL FK out.
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { intakeBatchStatus, intakeBatchSudStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { intakeRecordsRequests } from "./intake-records-request";

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
    // F-237 (0308) — §7.4 W4 / D8 SUD detection: state, DEK-enveloped evidence (DENYLISTED §3.6), which
    // detectors ran, and the reviewer's resolution (reason DENYLISTED). Resolver + time set together.
    sudStatus: intakeBatchSudStatus("sud_status").notNull().default("not_detected"),
    sudEvidenceCipher: text("sud_evidence_cipher"),
    sudDetectorRef: text("sud_detector_ref"),
    sudResolvedByMembershipId: uuid("sud_resolved_by_membership_id"),
    sudResolvedAt: timestamp("sud_resolved_at", { withTimezone: true }),
    sudResolutionReason: text("sud_resolution_reason"),
    // F-237 — `[{page, width, height}]` in Docling's units; the review overlay scales boxes by it.
    pageGeometry: jsonb("page_geometry"),
    // F-238 (0312) — the M6 referral these records are for (app-validated via ReferralReader; no FK), and
    // the worst per-document identity verdict (match|possible|mismatch|unverified|no_target).
    referralId: uuid("referral_id"),
    identityStatus: text("identity_status"),
    // F-238 (0313) — the outbound records request this batch answers (code on the pages, or linked at
    // upload). Same-module FK to intake_records_request.
    recordsRequestId: uuid("records_request_id").references(() => intakeRecordsRequests.id),
    // F-238 (0314) — a records-request code on the pages names ANOTHER referral / patient than the one
    // the batch is filed under: not moved, kept here so every screen can warn. Cleared on relink there.
    recordsRequestConflictId: uuid("records_request_conflict_id").references(
      () => intakeRecordsRequests.id,
    ),
    recordsRequestConflictKind: text("records_request_conflict_kind"),
    uploadedByMembershipId: uuid("uploaded_by_membership_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    dispositionAt: timestamp("disposition_at", { withTimezone: true }),
  },
  (t) => ({
    byOrgPatient: index("intake_batch_org_patient_idx").on(t.organizationId, t.patientId),
    byOrgReferral: index("intake_batch_org_referral_idx")
      .on(t.organizationId, t.referralId)
      .where(sql`referral_id IS NOT NULL`),
    byOrgRecordsRequest: index("intake_batch_org_records_request_idx")
      .on(t.organizationId, t.recordsRequestId)
      .where(sql`records_request_id IS NOT NULL`),
    pendingReview: index("intake_batch_pending_review_idx")
      .on(t.organizationId)
      .where(sql`status IN ('extraction_complete','in_review')`),
    recordsRequestConflict: check(
      "intake_upload_batch_records_request_conflict_chk",
      sql`(records_request_conflict_id IS NULL) = (records_request_conflict_kind IS NULL) AND (records_request_conflict_kind IS NULL OR records_request_conflict_kind IN ('code_names_another_referral', 'code_names_another_patient'))`,
    ),
    dispositionShape: check(
      "intake_upload_batch_disposition_shape",
      sql`(status IN ('writeback_complete','discarded')) = (disposition_at IS NOT NULL)`,
    ),
  }),
);

export type IntakeUploadBatch = typeof intakeUploadBatches.$inferSelect;
export type NewIntakeUploadBatch = typeof intakeUploadBatches.$inferInsert;
