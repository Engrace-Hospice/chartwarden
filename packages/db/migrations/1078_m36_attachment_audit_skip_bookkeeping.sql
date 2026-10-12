-- M36 WP 1.5 hardening — stop auditing pure scan-sweep bookkeeping.
--
-- The 1075 write-audit trigger inserted an audit_event for EVERY update of message_attachment, including the sweep's
-- retry bookkeeping (scan_attempts, last_scan_attempt_at, object_missing_count, first_object_missing_at): a poison row
-- retried hourly (or an outage across thousands of rows) wrote an audit row per attempt and buried the real events
-- (completion, verdict, bind, destruction). An UPDATE that changes ONLY those four columns is skipped; everything else
-- (scan_state, message_id, scanned_at, scan_signature, completed_at, object_destroyed_at, ...) is audited exactly as before,
-- with the same scrubbing of filename and object_key (PHI / storage-internal).
CREATE OR REPLACE FUNCTION audit_phi_write_message_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - ARRAY['scan_attempts','last_scan_attempt_at','object_missing_count','first_object_missing_at']::text[])
     = (to_jsonb(OLD) - ARRAY['scan_attempts','last_scan_attempt_at','object_missing_count','first_object_missing_at']::text[])
  THEN
    RETURN NEW;
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['filename','object_key']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['filename','object_key']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_attachment.' || lower(TG_OP), 'message_attachment',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;
