-- compat: expand
-- M10 HOPE - the write-audit trigger of `hope_submission_item` stops converting the XML column.
-- `audit_phi_write_hope_submission_item()` (0035) built its row images with `audit_scrub(to_jsonb(OLD), ...)`: `to_jsonb(row)`
-- reads EVERY column, and `iqies_validation_result` holds the record's CMS XML as base64 (tens of KB, TOASTed) until the batch
-- is answered. Cancel and the result import rewrite up to 200 items in ONE statement (`UPDATE ... FROM (VALUES ...)`), and each
-- row fired the trigger, which detoasted that value twice (OLD and NEW) only to replace it with the `<changed>` marker, while
-- the submission row lock was held. The images are now built from the other columns by name and `iqies_validation_result` is
-- never read: the same change 1497 made for `hope_submission`.
-- The audit rows are the same: the keys, the values and their JSON encodings (`jsonb_build_object` and `to_jsonb(row)` encode a
-- column with the same code), and `audit_scrub` and its denylist (`v_cols`, unchanged: `iqies_validation_result`) still decide
-- what is replaced. `iqies_validation_result` still reads `"<changed>"` (the placeholder below is replaced because the key is
-- in `v_cols`; it is never the column's value, so dropping the key from `v_cols` would record null, not the XML). The live suite
-- (m10-hope-submission-result.live.test.ts, "audit_phi_write_hope_submission_item") proves it on INSERT, UPDATE and DELETE: the
-- audit row equals `audit_scrub(to_jsonb(row), ...)` of the stored rows, its keys are exactly the table's columns, and an UPDATE
-- of an item holding a 1.5 MB result reads none of it out of TOAST.
-- THE COLUMN LIST IS THE TABLE'S: a column added to `hope_submission_item` must be added to BOTH images below in the same
-- migration (the live test above and hope-submission-audit-trigger.test.ts fail otherwise), or its changes would stop being
-- audited. `jsonb_build_object` takes at most 100 arguments (a Postgres limit, 50 key/value pairs): the images use 18 columns =
-- 36, so a table growing past 50 columns needs the image built in two halves joined with `||`.
-- Only the function body changes: SECURITY DEFINER, the owner and the trigger are as they were. The search_path gains the
-- trailing `pg_temp` and the helper and the table are schema-qualified (the 1062 convention).
-- The trigger is restated by CREATE OR REPLACE TRIGGER only because arch:audit-denylist-sync finds a function's table from the
-- `CREATE ... TRIGGER ... ON <table>` that follows it in the same file; the function replace alone changes the behaviour, and the
-- restatement replaces nothing.
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cols text[] := ARRAY['iqies_validation_result']::text[];
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := public.audit_scrub(jsonb_build_object(
      'id', OLD.id,
      'organization_id', OLD.organization_id,
      'hope_submission_id', OLD.hope_submission_id,
      'hope_assessment_id', OLD.hope_assessment_id,
      'item_status', OLD.item_status,
      'operation', OLD.operation,
      'spec_version_id', OLD.spec_version_id,
      'assessment_version', OLD.assessment_version,
      'validation_profile', OLD.validation_profile,
      'xml_filename', OLD.xml_filename,
      'xml_storage_uri', OLD.xml_storage_uri,
      'xml_sha256', OLD.xml_sha256,
      'xml_size_bytes', OLD.xml_size_bytes,
      'iqies_record_id', OLD.iqies_record_id,
      'iqies_validation_result', NULL::text,
      'processed_at', OLD.processed_at,
      'created_at', OLD.created_at,
      'updated_at', OLD.updated_at
    ), v_cols);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := public.audit_scrub(jsonb_build_object(
      'id', NEW.id,
      'organization_id', NEW.organization_id,
      'hope_submission_id', NEW.hope_submission_id,
      'hope_assessment_id', NEW.hope_assessment_id,
      'item_status', NEW.item_status,
      'operation', NEW.operation,
      'spec_version_id', NEW.spec_version_id,
      'assessment_version', NEW.assessment_version,
      'validation_profile', NEW.validation_profile,
      'xml_filename', NEW.xml_filename,
      'xml_storage_uri', NEW.xml_storage_uri,
      'xml_sha256', NEW.xml_sha256,
      'xml_size_bytes', NEW.xml_size_bytes,
      'iqies_record_id', NEW.iqies_record_id,
      'iqies_validation_result', NULL::text,
      'processed_at', NEW.processed_at,
      'created_at', NEW.created_at,
      'updated_at', NEW.updated_at
    ), v_cols);
  END IF;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_submission_item.' || lower(TG_OP),
    'hope_submission_item',
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
ALTER FUNCTION audit_phi_write_hope_submission_item() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_audit_hope_submission_item" AFTER INSERT OR UPDATE OR DELETE ON hope_submission_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission_item();
