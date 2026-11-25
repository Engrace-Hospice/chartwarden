-- compat: contract
-- Rename the object-store key columns that still carry the retired "minio" vendor name. Production object storage is SeaweedFS (dev/CI: RustFS); the
-- columns hold an S3 object key and always did, whichever store served it. Nothing else changes: types, nullability, RLS, grants and data are untouched.
--
--   document_version.minio_object_key             -> object_key          (M22; NOT NULL; unique index document_version_minio_key_uk -> document_version_object_key_uk, rebuilt)
--   remittance_advice.minio_object_key            -> object_key          (M25; NOT NULL)
--   fhir_bulk_export_artifact.minio_object_key    -> object_key          (M28; NOT NULL)
--   dsar_export_job.bundle_minio_object_key       -> bundle_object_key   (M34; nullable)
--   tenant_export_job.bundle_minio_object_key     -> bundle_object_key   (M34; nullable)
-- None of the five tables already had an `object_key` / `bundle_object_key` column, so the vendor-neutral names are free (no `object_store_key` fallback).
--
-- CONTRACT, NOT EXPAND. The previous release reads and writes the old names, so it cannot run against the renamed schema. deploy.sh therefore refuses this
-- migration (`migrate.ts --hold-contract`, exit 75, before any DDL) and an operator applies it by hand after the API and workers are drained:
-- docs/runbooks/object-key-column-rename-deployment.md. A rename back is a second contract migration, never a rollback.
--
-- THE AUDIT SCRUB TRAP. `audit_phi_write_document_version()` (0049) scrubs the object key out of every audit image by NAME:
-- `audit_scrub(to_jsonb(NEW), ARRAY['byte_payload_cipher', 'minio_object_key'])`. A column rename does not touch that string, so leaving it would keep the
-- function running while the renamed `object_key` (tenant + patient prefix, DENYLISTED §3.6) went into audit_event in clear: a silent PHI/audit regression.
-- The function is replaced below with the new name, in this same transaction, and the final block fails the migration if ANY function, trigger, policy or
-- view, or any column, index or constraint of the five renamed tables, still names the old columns (so a catalog object this file missed, or a hand-made
-- one in production, aborts the migration rather than going quiet; the runbook has the same query for the operator to run before the window).
-- Audit rows already written keep their old image key `minio_object_key: "<changed>"` (audit_event is append-only; the value was
-- scrubbed, only the key's name is old); new rows carry `object_key: "<changed>"`. No other audit trigger names these columns: the M25, M28 and M34
-- triggers scrub nothing today (unchanged here), so their images carry the key as before.
--
-- Public names that do NOT change (deliberately, not renamed here): the `m25.edi.835_received` outbox payload field, the `POST /api/v1/internal/remittance/advices`
-- request field and the 277CA sidecar body field, all `minioObjectKey`, and the `bundleMinioObjectKey` JSON key inside persisted `tenant_export_job_event.shard_receipt`
-- (an `oversized_hold` row waiting for approval still carries it). They are mapped to the new names at the code boundary.
-- Bound every lock wait: RENAME COLUMN and the index rebuild take ACCESS EXCLUSIVE, and a session left idle in a transaction on one of these tables would
-- otherwise stall the window indefinitely (and, queued behind it, block every other statement on the table). The runner's BEGIN scopes this to the file.
-- A lock timeout (SQLSTATE 55P03) rolls this file back whole; it is safe to run again once the blocking session is gone. It bounds the wait, not the index build.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "document_version" RENAME COLUMN "minio_object_key" TO "object_key";--> statement-breakpoint
-- The unique index is rebuilt, not renamed: RENAME COLUMN leaves the index's own key-column name (`pg_attribute`, shown by `\d <index>`) at `minio_object_key`, and
-- only a rebuild gives it the new one. Uniqueness is unbroken: DROP and CREATE share this transaction and the table lock, with the writers already drained.
DROP INDEX "document_version_minio_key_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_object_key_uk" ON "document_version" ("object_key");--> statement-breakpoint
ALTER TABLE "remittance_advice" RENAME COLUMN "minio_object_key" TO "object_key";--> statement-breakpoint
ALTER TABLE "fhir_bulk_export_artifact" RENAME COLUMN "minio_object_key" TO "object_key";--> statement-breakpoint
ALTER TABLE "dsar_export_job" RENAME COLUMN "bundle_minio_object_key" TO "bundle_object_key";--> statement-breakpoint
ALTER TABLE "tenant_export_job" RENAME COLUMN "bundle_minio_object_key" TO "bundle_object_key";--> statement-breakpoint
-- PostgreSQL 18 keeps a NOT NULL constraint under its own name (`<table>_<column>_not_null`) and RENAME COLUMN does not rename it. Looked up by catalog, so
-- a database whose constraint names came from an upgrade (or none at all, before 18) still ends consistent.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS table_name, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'n'
       AND c.conrelid IN ('document_version'::regclass, 'remittance_advice'::regclass, 'fhir_bulk_export_artifact'::regclass)
       AND c.conname LIKE '%minio\_object\_key%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.table_name, r.conname, replace(r.conname, 'minio_object_key', 'object_key'));
  END LOOP;
END $$;--> statement-breakpoint
-- The body is 0049's with the new key name; the one other change is the 1062 convention (as in 1499): pg_temp LAST on the search_path of this SECURITY DEFINER
-- function, and the helper and the table schema-qualified. Owner, event and images are as they were.
CREATE OR REPLACE FUNCTION audit_phi_write_document_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['byte_payload_cipher', 'object_key']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['byte_payload_cipher', 'object_key']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'document_version.' || lower(TG_OP),
    'document_version',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_document_version() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger-to-function binding (the trigger itself did not change); restating it keeps the function and its trigger in one block.
CREATE OR REPLACE TRIGGER "trg_audit_document_version" AFTER INSERT OR UPDATE OR DELETE ON document_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_version();--> statement-breakpoint
-- Fail loud: nothing may still name the old columns after the renames. Functions (their text is never rewritten: the audit scrub list above all),
-- triggers, policies and views are checked database-wide; the columns, indexes and constraints of the five renamed tables are checked by NAME only (a
-- definition is rewritten by the rename). An object that is harmless (a scratch copy of a table, an ad hoc index on a renamed column) does not trip it. A hit
-- aborts this migration, which rolls back whole, instead of going silently stale. The objects this file itself renames or replaces are excused, which is also
-- what lets the SAME query run BEFORE the window (docs/runbooks/object-key-column-rename-deployment.md) and return no row on a healthy database.
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(what, ', ' ORDER BY what) INTO v_left FROM (
-- predicate:begin
WITH renamed AS (
  SELECT unnest(ARRAY['document_version', 'remittance_advice', 'fhir_bulk_export_artifact', 'dsar_export_job', 'tenant_export_job']::regclass[])::oid AS relid
)
SELECT 'function ' || p.oid::regprocedure::text AS what
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.proname <> 'audit_phi_write_document_version'
   AND p.prosrc ILIKE '%minio\_object\_key%'
UNION ALL
SELECT 'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname
  FROM pg_trigger t
 WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ILIKE '%minio\_object\_key%'
UNION ALL
SELECT 'policy ' || pol.tablename || '.' || pol.policyname
  FROM pg_policies pol
 WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') ILIKE '%minio\_object\_key%'
UNION ALL
SELECT 'view ' || v.schemaname || '.' || v.viewname
  FROM pg_views v
 WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema') AND v.definition ILIKE '%minio\_object\_key%'
UNION ALL
SELECT 'matview ' || m.schemaname || '.' || m.matviewname
  FROM pg_matviews m
 WHERE m.definition ILIKE '%minio\_object\_key%'
UNION ALL
SELECT 'column ' || a.attrelid::regclass::text || '.' || a.attname
  FROM pg_attribute a JOIN renamed r ON r.relid = a.attrelid
 WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE '%minio%'
   AND (a.attrelid::oid, a.attname::text) NOT IN (
     ('document_version'::regclass::oid, 'minio_object_key'),
     ('remittance_advice'::regclass::oid, 'minio_object_key'),
     ('fhir_bulk_export_artifact'::regclass::oid, 'minio_object_key'),
     ('dsar_export_job'::regclass::oid, 'bundle_minio_object_key'),
     ('tenant_export_job'::regclass::oid, 'bundle_minio_object_key'))
UNION ALL
SELECT 'index ' || ic.relname
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN renamed r ON r.relid = i.indrelid
 WHERE ic.relname ILIKE '%minio%' AND ic.relname <> 'document_version_minio_key_uk'
UNION ALL
SELECT 'constraint ' || c.conrelid::regclass::text || '.' || c.conname
  FROM pg_constraint c JOIN renamed r ON r.relid = c.conrelid
 WHERE c.conname ILIKE '%minio%' AND NOT (c.contype = 'n' AND c.conname LIKE '%\_minio\_object\_key\_not\_null')
-- predicate:end
  ) found;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'object-key rename incomplete: still naming the minio_object_key columns: %', v_left;
  END IF;
END $$;
