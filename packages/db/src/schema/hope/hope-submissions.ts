// @chartwarden/db — `hope_submission` (M10 §3.3). A per-CCN iQIES batch of signed+unsubmitted assessments
// for one submission period: the queued→in_flight→accepted/rejected/partially_accepted lifecycle
// (§2.2.4), the encrypted-at-rest envelope pointer (MinIO) + its sha256, and the accept/reject counts.
// Per-ProviderEntity (the CCN keys submission batching), NOT patient-level → carries organization_id +
// provider_entity_id but NO location_id / patient_id (outside the PHI three-column rule, §3.3 tenancy
// note). RLS keys on app.org_id alone. RLS + grants + the M4 write-audit trigger (acceptance_report /
// envelope_storage_uri / envelope_sha256 denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hopeSubmissionStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const hopeSubmissions = pgTable(
  "hope_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    submissionPeriod: text("submission_period").notNull(), // e.g. "2026-Q2" or "2026-06"
    status: hopeSubmissionStatus("status").notNull().default("queued"),
    iqiesBatchId: text("iqies_batch_id"), // iQIES-assigned, nullable until in_flight
    transportMode: text("transport_mode").notNull().default("manual_iqies_upload"),
    validationProfile: text("validation_profile"),
    packageFilename: text("package_filename"),
    packageStorageUri: text("package_storage_uri"),
    packageSha256: text("package_sha256"),
    packageSizeBytes: integer("package_size_bytes"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedByMembershipId: uuid("exported_by_membership_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByMembershipId: uuid("submitted_by_membership_id"),
    iqiesSubmissionReference: text("iqies_submission_reference"),
    resultImportedAt: timestamp("result_imported_at", { withTimezone: true }),
    resultImportedByMembershipId: uuid("result_imported_by_membership_id"),
    resultReportHash: text("result_report_hash"),
    fileLevelResult: jsonb("file_level_result"),
    // NOT NULL relaxed in mig 0130 (M10L): a `queued` submission has no envelope yet — the transmit
    // worker (§4.10) populates the URI + digest at assembly/transmit time.
    envelopeStorageUri: text("envelope_storage_uri"), // MinIO encrypted-at-rest (null until transmit)
    envelopeSha256: text("envelope_sha256"),
    itemCount: integer("item_count").notNull(),
    acceptedCount: integer("accepted_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    transmittedAt: timestamp("transmitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptanceReport: jsonb("acceptance_report"), // redacted iQIES response
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgPeriod: index("idx_hope_sub_org_period").on(
      t.organizationId,
      t.submissionPeriod,
      t.status,
    ),
    byOrgQueued: index("idx_hope_sub_org_queued")
      .on(t.organizationId, t.status, t.createdAt)
      .where(sql`status IN ('queued','in_flight')`),
  }),
);

export type HopeSubmission = typeof hopeSubmissions.$inferSelect;
export type NewHopeSubmission = typeof hopeSubmissions.$inferInsert;
