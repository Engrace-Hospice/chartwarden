-- GAP-078 follow-up — M26 PS&R import row quarantine.
--
-- A single malformed PS&R row no longer fails the whole import: the row is quarantined (excluded from the
-- totals and from the reconcile) and the import records how many rows were set aside plus a PHI-free detail
-- document (1-based line numbers + error codes only; never an MBI or a cell value). Both columns are NULL
-- until the reconcile job has run and stay NULL when nothing was quarantined or the file failed structurally.
-- Additive. The existing table-level GRANT SELECT/INSERT/UPDATE to wardenx_app, the FORCEd RLS policy and the
-- audit trigger (which scrubs only parse_error; this document carries no PHI) already cover the new columns.
ALTER TABLE "cap_psr_import" ADD COLUMN IF NOT EXISTS "rows_quarantined" integer;--> statement-breakpoint
ALTER TABLE "cap_psr_import" ADD COLUMN IF NOT EXISTS "quarantine_detail" jsonb;
