-- compat: expand
-- M10 HOPE - the write-audit trigger of `hope_submission` stops converting the package column.
-- `audit_phi_write_hope_submission()` (0035) built its row images with `audit_scrub(to_jsonb(OLD), ...)`: `to_jsonb(row)`
-- reads EVERY column, and `acceptance_report` holds the package ZIP as base64 (multi-MB jsonb, TOASTed), so each cancel,
-- mark-uploaded, download-advance and result UPDATE detoasted it twice (OLD and NEW) inside the server only to replace it with the
-- `<changed>` marker. The images are now built from the other columns by name and `acceptance_report` is never read.
-- The audit rows are the same: the keys, the values and their JSON encodings (`jsonb_build_object` and `to_jsonb(row)` encode
-- a column with the same code), `audit_scrub` and its denylist (`v_cols`, unchanged) still decide what is replaced, and
-- `acceptance_report` still reads `"<changed>"` (the placeholder below is replaced because the key is in `v_cols`; it is
-- never the column's value, so dropping the key from `v_cols` would record null, not the ZIP). The live suite
-- (m10-hope-submission-result.live.test.ts, "audit_phi_write_hope_submission") proves it on INSERT, UPDATE and DELETE: the
-- audit row equals `audit_scrub(to_jsonb(row), ...)` of the stored rows, and its keys are exactly the table's columns.
-- THE COLUMN LIST IS THE TABLE'S: a column added to `hope_submission` must be added to BOTH images below in the same
-- migration (the live test above and hope-submission-audit-trigger.test.ts fail otherwise), or its changes would stop
-- being audited. Only the function body changes: SECURITY DEFINER, the owner and the trigger are as they were. The
-- search_path gains the trailing `pg_temp` and the helper and the table are schema-qualified (the 1062 convention).
-- CREATE OR REPLACE TRIGGER restates the trigger unchanged (arch:audit-denylist-sync reads a function and its trigger
-- together); it takes the same lock a CREATE TRIGGER would and replaces nothing.
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cols text[] := ARRAY['acceptance_report', 'envelope_storage_uri', 'envelope_sha256']::text[];
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := public.audit_scrub(jsonb_build_object(
      'id', OLD.id,
      'organization_id', OLD.organization_id,
      'provider_entity_id', OLD.provider_entity_id,
      'submission_period', OLD.submission_period,
      'status', OLD.status,
      'iqies_batch_id', OLD.iqies_batch_id,
      'transport_mode', OLD.transport_mode,
      'validation_profile', OLD.validation_profile,
      'package_filename', OLD.package_filename,
      'package_storage_uri', OLD.package_storage_uri,
      'package_sha256', OLD.package_sha256,
      'package_size_bytes', OLD.package_size_bytes,
      'exported_at', OLD.exported_at,
      'exported_by_membership_id', OLD.exported_by_membership_id,
      'submitted_at', OLD.submitted_at,
      'submitted_by_membership_id', OLD.submitted_by_membership_id,
      'iqies_submission_reference', OLD.iqies_submission_reference,
      'result_imported_at', OLD.result_imported_at,
      'result_imported_by_membership_id', OLD.result_imported_by_membership_id,
      'result_report_hash', OLD.result_report_hash,
      'report_reference', OLD.report_reference,
      'cancelled_at', OLD.cancelled_at,
      'cancelled_by_membership_id', OLD.cancelled_by_membership_id,
      'cancel_reason_code', OLD.cancel_reason_code,
      'file_level_result', OLD.file_level_result,
      'envelope_storage_uri', OLD.envelope_storage_uri,
      'envelope_sha256', OLD.envelope_sha256,
      'item_count', OLD.item_count,
      'accepted_count', OLD.accepted_count,
      'rejected_count', OLD.rejected_count,
      'transmitted_at', OLD.transmitted_at,
      'accepted_at', OLD.accepted_at,
      'acceptance_report', NULL::text,
      'created_at', OLD.created_at,
      'updated_at', OLD.updated_at
    ), v_cols);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := public.audit_scrub(jsonb_build_object(
      'id', NEW.id,
      'organization_id', NEW.organization_id,
      'provider_entity_id', NEW.provider_entity_id,
      'submission_period', NEW.submission_period,
      'status', NEW.status,
      'iqies_batch_id', NEW.iqies_batch_id,
      'transport_mode', NEW.transport_mode,
      'validation_profile', NEW.validation_profile,
      'package_filename', NEW.package_filename,
      'package_storage_uri', NEW.package_storage_uri,
      'package_sha256', NEW.package_sha256,
      'package_size_bytes', NEW.package_size_bytes,
      'exported_at', NEW.exported_at,
      'exported_by_membership_id', NEW.exported_by_membership_id,
      'submitted_at', NEW.submitted_at,
      'submitted_by_membership_id', NEW.submitted_by_membership_id,
      'iqies_submission_reference', NEW.iqies_submission_reference,
      'result_imported_at', NEW.result_imported_at,
      'result_imported_by_membership_id', NEW.result_imported_by_membership_id,
      'result_report_hash', NEW.result_report_hash,
      'report_reference', NEW.report_reference,
      'cancelled_at', NEW.cancelled_at,
      'cancelled_by_membership_id', NEW.cancelled_by_membership_id,
      'cancel_reason_code', NEW.cancel_reason_code,
      'file_level_result', NEW.file_level_result,
      'envelope_storage_uri', NEW.envelope_storage_uri,
      'envelope_sha256', NEW.envelope_sha256,
      'item_count', NEW.item_count,
      'accepted_count', NEW.accepted_count,
      'rejected_count', NEW.rejected_count,
      'transmitted_at', NEW.transmitted_at,
      'accepted_at', NEW.accepted_at,
      'acceptance_report', NULL::text,
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
    'hope_submission.' || lower(TG_OP),
    'hope_submission',
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
ALTER FUNCTION audit_phi_write_hope_submission() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_audit_hope_submission" AFTER INSERT OR UPDATE OR DELETE ON hope_submission
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission();
