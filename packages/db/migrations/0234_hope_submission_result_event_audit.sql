-- M10 HOPE / M04 — write-audit trigger for `hope_submission_result_event` (created in 0226, RLS in 0233).
--
-- The table records each iQIES result the manual-upload import reads back: org-scoped (organization_id
-- NOT NULL) and linked to the patient's submission, so every write must be audited like its parent
-- `hope_submission_item` (0035). The generic `wardenx_audit_trigger()` would copy `raw_result` (the
-- vendor response as received) and the free-text CMS `message` into the immutable audit log verbatim,
-- so this uses the same per-table SECURITY DEFINER shape as `audit_phi_write_hope_submission_item()`,
-- with those two columns scrubbed through `audit_scrub()`. The column list is mirrored in
-- `M10_AUDIT_DENYLIST.hope_submission_result_event` (packages/types/src/hope.ts), which
-- arch:audit-denylist-sync keeps in exact agreement with this function.
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission_result_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['raw_result','message']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['raw_result','message']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
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
ALTER FUNCTION audit_phi_write_hope_submission_result_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_hope_submission_result_event" ON hope_submission_result_event;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_submission_result_event" AFTER INSERT OR UPDATE OR DELETE ON hope_submission_result_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission_result_event();
