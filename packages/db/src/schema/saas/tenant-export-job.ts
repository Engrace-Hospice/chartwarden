// @chartwarden/db — `tenant_export_job` (M34 SaaS Tenant Platform §3.7). The tenant-export job: one row
// per whole-tenant data export (migration, BAA termination, compliance audit, surveyor request),
// driving the D19 bundle (per-module NDJSON + documents, uploaded to MinIO, 7-day object expiry).
//
// M34-F02 / ADR-0010 / SD-028: NEW table — ships `organization_id` NOT NULL day one (canonical
// app.org_id RLS predicate applies directly). Only the org spine carries a SQL FK; the requesting
// membership is a plain uuid app-validated cross-module ref. SEC-052 bulk-export controls add
// `bundle_downloaded_by_membership_id` + `bundle_presigned_url_last_generated_at`. RLS + grants +
// the M4 write-audit trigger land in 0052/0053.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantExportJobPurpose, tenantExportJobStatus } from "../../enums";
import { organizations } from "../organizations";

export const tenantExportJob = pgTable(
  "tenant_export_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (new table — ships NOT NULL day one).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    requestedPurpose: tenantExportJobPurpose("requested_purpose").notNull(),
    requestingMembershipId: uuid("requesting_membership_id").notNull(), // M1 membership (app-validated)
    status: tenantExportJobStatus("status").notNull().default("requested"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    bundleMinioObjectKey: text("bundle_minio_object_key"),
    bundleSha256: text("bundle_sha256"),
    // GAP-097: bigint stored as text per M1 convention (the M22 `document_version.byte_size` precedent)
    // — SEC-052 oversized bundles are BY DEFINITION over the 50GB `TENANT_EXPORT_MAX_BYTES` threshold,
    // well past a plain `integer` column's ~2GB ceiling (was `integer`; overflowed on the very sizes
    // this table exists to record — migration 0195).
    bundleSizeBytes: text("bundle_size_bytes"),
    bundleModuleInventory: jsonb("bundle_module_inventory"),
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
    orgStatusIdx: index("tenant_export_org_status_idx").on(t.organizationId, t.status),
    presignedExpiresIdx: index("tenant_export_presigned_expires_idx").on(
      t.bundlePresignedUrlExpiresAt,
    ),
  }),
);

export type TenantExportJob = typeof tenantExportJob.$inferSelect;
export type NewTenantExportJob = typeof tenantExportJob.$inferInsert;
