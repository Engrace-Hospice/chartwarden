// @wardenx/db — `dsar_export_job` (M34 SaaS Tenant Platform §3.7). The DSAR (data-subject access
// request) export job: one row per patient-scoped disclosure request, driving the §7.3 / §8.2
// DSAR Bundle (FHIR R4 + rendered chart) honoring M5/M39 Part 2 redaction-by-default.
//
// M34-F02 / ADR-0010 / SD-028: NEW table — ships `organization_id` NOT NULL day one (canonical
// app.org_id RLS predicate applies directly). Only the org spine carries a SQL FK; cross-module
// logical refs (M5 patient, M1 membership, M22 bundle document) are plain uuid app-validated.
// phiClass='phi_sensitive' (M34-F13 / ADR-0014 / SEC-046 — potential 42 CFR Part 2). SEC-052
// bulk-export controls add `bundle_downloaded_by_membership_id` +
// `bundle_presigned_url_last_generated_at`. RLS + grants + the M4 write-audit trigger land in 0052/0053.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { dsarExportJobStatus, dsarRequestSource } from "../../enums";
import { organizations } from "../organizations";

export const dsarExportJob = pgTable(
  "dsar_export_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (new table — ships NOT NULL day one).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (follows merged_into_id at create time)
    requestSource: dsarRequestSource("request_source").notNull(),
    requestorIdentityVerificationEvidence: text(
      "requestor_identity_verification_evidence",
    ).notNull(),
    requestingMembershipId: uuid("requesting_membership_id").notNull(), // M1 membership (app-validated)
    status: dsarExportJobStatus("status").notNull().default("requested"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
    extendedUntil: timestamp("extended_until", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    deniedReason: text("denied_reason"),
    bundleDocumentId: uuid("bundle_document_id"), // M22 doc id (app-validated)
    bundleMinioObjectKey: text("bundle_minio_object_key"),
    bundleSha256: text("bundle_sha256"),
    bundlePresignedUrlExpiresAt: timestamp("bundle_presigned_url_expires_at", {
      withTimezone: true,
    }),
    // SEC-052 bulk-export controls (§3.7): last-generated URL timestamp (audit reconstruction) +
    // the downloading actor's membership id, recorded alongside bundle_downloaded_at.
    bundlePresignedUrlLastGeneratedAt: timestamp("bundle_presigned_url_last_generated_at", {
      withTimezone: true,
    }),
    bundleDownloadedAt: timestamp("bundle_downloaded_at", { withTimezone: true }),
    bundleDownloadedByMembershipId: uuid("bundle_downloaded_by_membership_id"), // M1 membership (app-validated)
  },
  (t) => ({
    // M34-F02 / ADR-0010: SD-028 composite index leads with organization_id.
    orgPatientIdx: index("dsar_export_org_patient_idx").on(t.organizationId, t.patientId),
    slaIdx: index("dsar_export_sla_idx")
      .on(t.slaDueAt)
      .where(sql`status IN ('requested','generating','review_pending','extended')`),
    extensionCheck: check(
      "dsar_extension_check",
      sql`extended_until IS NULL OR extended_until <= sla_due_at + interval '30 days'`,
    ),
  }),
);

export type DsarExportJob = typeof dsarExportJob.$inferSelect;
export type NewDsarExportJob = typeof dsarExportJob.$inferInsert;
