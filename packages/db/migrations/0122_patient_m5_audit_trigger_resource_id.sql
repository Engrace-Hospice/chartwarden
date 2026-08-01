-- M5 Patient §3.8 — the write-audit triggers on the two `patient_id`-keyed tables reference a column
-- that does not exist, so INSERT into either table FAILS.
--
-- `generateAuditTrigger()` emits `COALESCE(NEW.id, OLD.id)` for `resource_id`, which is right for the
-- 300-odd tables that carry a surrogate `id`. `patient_communication_preference` and
-- `patient_privacy_flag_snapshot` do not: a chart has exactly one of each, so their PRIMARY KEY is
-- `patient_id`. plpgsql resolves `NEW.id` at execution time, so 0021 applied cleanly and the failure
-- only appears when a row is written:
--
--     ERROR: record "new" has no field "id"
--     PL/pgSQL function audit_phi_write_patient_communication_preference() line 10
--
-- Both tables are therefore UNWRITABLE in production today. It went unnoticed because M5's routes are
-- read-only so far (`mountPatientRoutes` serves census/chart reads), because the trigger is AFTER-row
-- and cannot fail at CREATE time, and because no live suite had ever inserted into them — which is
-- exactly the gap m5-rls-isolation.live.test.ts was written to close. It surfaced on the first seed.
--
-- Verified exhaustively rather than by inspection: these are the ONLY two tables in the schema whose
-- audit trigger references NEW.id while having no `id` column —
--   SELECT c.relname FROM pg_class c JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
--     JOIN pg_proc p ON p.oid = t.tgfoid
--    WHERE pg_get_functiondef(p.oid) LIKE '%NEW.id%'
--      AND NOT EXISTS (SELECT 1 FROM information_schema.columns
--                       WHERE table_name = c.relname AND column_name = 'id');
--
-- The fix replaces `NEW.id` with `NEW.patient_id` — which is both the primary key AND the correct
-- §164.528 accounting subject for these rows, so the audit row now points at the patient the
-- preference/flag belongs to rather than at nothing. Everything else in the two functions is the
-- generator's output, reproduced verbatim so a future regeneration diffs cleanly.

CREATE OR REPLACE FUNCTION audit_phi_write_patient_communication_preference() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_communication_preference.' || lower(TG_OP),
    'patient_communication_preference',
    COALESCE(NEW.patient_id, OLD.patient_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_patient_communication_preference() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_patient_privacy_flag_snapshot() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_privacy_flag_snapshot.' || lower(TG_OP),
    'patient_privacy_flag_snapshot',
    COALESCE(NEW.patient_id, OLD.patient_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_patient_privacy_flag_snapshot() OWNER TO wardenx_audit_writer;
