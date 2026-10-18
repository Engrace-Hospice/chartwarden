-- Additive M6 contract facts. NULL means legacy fact unknown; no inferred backfill.
ALTER TABLE "notice_of_rights_acknowledgment" ADD COLUMN IF NOT EXISTS "acknowledged_at_instant" timestamptz;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD COLUMN IF NOT EXISTS "acknowledged_by_name" text;--> statement-breakpoint
ALTER TABLE "election_statement" ADD COLUMN IF NOT EXISTS "declared_effective_date" date;--> statement-breakpoint
ALTER TABLE "election_statement" ADD COLUMN IF NOT EXISTS "primary_diagnosis_icd10_at_election" text;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ADD COLUMN IF NOT EXISTS "prognosis_statement" text;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ADD COLUMN IF NOT EXISTS "clinical_findings" jsonb;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD COLUMN IF NOT EXISTS "requested_window_start" date;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD COLUMN IF NOT EXISTS "requested_window_end" date;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD COLUMN IF NOT EXISTS "authoritative_window_start" date;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD COLUMN IF NOT EXISTS "authoritative_window_end" date;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_notice_of_rights_acknowledgment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['acknowledged_by_name']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['acknowledged_by_name']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'notice_of_rights.' || lower(TG_OP),
    'notice_of_rights',
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
ALTER FUNCTION audit_phi_write_notice_of_rights_acknowledgment() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_election_statement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_name_at_signing', 'state_addendum', 'primary_diagnosis_icd10_at_election']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_name_at_signing', 'state_addendum', 'primary_diagnosis_icd10_at_election']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'election_statement.' || lower(TG_OP),
    'election_statement',
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
ALTER FUNCTION audit_phi_write_election_statement() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_certification_of_terminal_illness() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['late_reason', 'narrative', 'prognosis_statement', 'clinical_findings']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['late_reason', 'narrative', 'prognosis_statement', 'clinical_findings']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'cti.' || lower(TG_OP),
    'cti',
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
ALTER FUNCTION audit_phi_write_certification_of_terminal_illness() OWNER TO wardenx_audit_writer;--> statement-breakpoint
