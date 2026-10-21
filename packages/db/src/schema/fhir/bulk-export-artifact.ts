// @chartwarden/db — `fhir_bulk_export_artifact` (M28 §3.3). One row per NDJSON output object of a completed
// bulk-export job — the per-resource-type MinIO object key, byte size, row count and checksum.
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). Checksums and counts only
// (the empty §3.6 denylist) so it audits through M1's baseline `wardenx_audit_trigger()`. `job_id` carries
// a REAL FK to `fhir_bulk_export_job` (ON DELETE cascade). The eraser (§3.7) purges `minio_object_key`
// from MinIO while the row metadata persists for audit reconstruction.
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fhirBulkExportJob } from "./bulk-export-job";

export const fhirBulkExportArtifact = pgTable(
  "fhir_bulk_export_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => fhirBulkExportJob.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    /** 'tenants/<org>/fhir-exports/<job>/{type}.ndjson'. */
    minioObjectKey: text("minio_object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    rowCount: integer("row_count").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index("fhir_bulk_export_artifact_job_idx").on(t.jobId),
  }),
);

export type FhirBulkExportArtifactRow = typeof fhirBulkExportArtifact.$inferSelect;
export type NewFhirBulkExportArtifactRow = typeof fhirBulkExportArtifact.$inferInsert;
