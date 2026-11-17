-- compat: expand
-- M10 HOPE - the write-audit trigger of `hope_submission_result_event` also scrubs `report_reference`.
-- 0234 scrubbed `raw_result` (the CMS response as received) and `message` (free-text CMS message). `report_reference` is the CMS
-- report reference an operator types on a result import (up to 500 chars): operator free text, screened for patient
-- identifiers at the route, but copied unscrubbed into the immutable audit trail on every INSERT of a report row. It now reads
-- `"<changed>"` in the audit images, like the other two; the value stays in the row. `hope_submission.report_reference` is
-- scrubbed the same way (1497).
-- Only the function body changes (the scrub list): the images, the event and the owner are as they were. The search_path gains
-- the trailing `pg_temp` and the helper and the table are schema-qualified (the 1062 convention). The trigger is restated
-- unchanged because arch:audit-denylist-sync finds a function's table from the `CREATE ... TRIGGER ... ON <table>` that follows
-- it in the same file; the function replace alone changes the behaviour.
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission_result_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['raw_result','message','report_reference']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['raw_result','message','report_reference']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_submission_result_event.' || lower(TG_OP),
    'hope_submission_result_event',
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
ALTER FUNCTION audit_phi_write_hope_submission_result_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_audit_hope_submission_result_event" AFTER INSERT OR UPDATE OR DELETE ON hope_submission_result_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission_result_event();
