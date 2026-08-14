-- GAP-097 — `tenant_export_job.bundle_size_bytes` was `integer` (max ~2GB), but SEC-052's own oversized
-- threshold (`TENANT_EXPORT_MAX_BYTES`, packages/saas-tenant-platform) is 50GB — every bundle that ever
-- reaches the `oversized_hold` this table exists to track is, by definition, already past int4's ceiling.
-- Caught live: `approveOversizedExport`'s `UPDATE` on a real 60GB fixture failed
-- "value out of range for type integer" before this migration.
--
-- Widened to `text` (bigint-stored-as-text), the SAME convention `document_version.byte_size`
-- (packages/db/src/schema/documents/document-version.ts) already uses for this exact class of value —
-- not a native `bigint` column, matching that precedent rather than introducing a second convention.
ALTER TABLE "tenant_export_job"
  ALTER COLUMN "bundle_size_bytes" TYPE text USING "bundle_size_bytes"::text;
