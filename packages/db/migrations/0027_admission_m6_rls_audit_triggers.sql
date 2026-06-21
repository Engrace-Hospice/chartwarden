-- M6 Admission, Election & Certification §3.6 (RLS + grants) + §3.7 (write-audit triggers) — M6-T03.
--
-- Tables/enums/indexes/FKs/CHECKs land in 0026 (drizzle-generated). This migration locks:
--   • standard app.org_id org-scope RLS on all twelve M6 tables (ADR-0010 D2: row visibility keys
--     ONLY on app.org_id, set by withOrgContext());
--   • the §3.6 grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (domain rows
--     are never deleted; supersession is via the status enums voided/superseded/closed/completed);
--   • the M4 write-audit trigger (generateAuditTrigger) on every table, with the §3.7 PHI/PII
--     denylist so free-text clinical narrative + high-sensitivity intake PII never land in the
--     audit diff. All twelve carry organization_id, so all twelve get BOTH an RLS policy and a
--     trigger (arch:gaps phi-guards floor).
-- No M6 table has a non-UUID PK or a missing organization_id, so every table takes the M4 generator
-- (unlike M38/M39 platform-reference tables that needed the M1 baseline trigger).--> statement-breakpoint
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint
-- 1. Org-scope RLS + grants (standard app.org_id; §3.6). No DELETE — supersession via status.--> statement-breakpoint
ALTER TABLE "referral" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "referral_org" ON "referral";--> statement-breakpoint
CREATE POLICY "referral_org" ON "referral"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "referral" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "referral" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "admission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "admission_org" ON "admission";--> statement-breakpoint
CREATE POLICY "admission_org" ON "admission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "admission" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "admission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "election_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "election_period_org" ON "election_period";--> statement-breakpoint
CREATE POLICY "election_period_org" ON "election_period"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "election_period" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "election_period" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "election_statement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "election_statement_org" ON "election_statement";--> statement-breakpoint
CREATE POLICY "election_statement_org" ON "election_statement"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "election_statement" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "election_statement" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "certification_of_terminal_illness_org" ON "certification_of_terminal_illness";--> statement-breakpoint
CREATE POLICY "certification_of_terminal_illness_org" ON "certification_of_terminal_illness"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "certification_of_terminal_illness" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "certification_of_terminal_illness" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "face_to_face_encounter_org" ON "face_to_face_encounter";--> statement-breakpoint
CREATE POLICY "face_to_face_encounter_org" ON "face_to_face_encounter"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "face_to_face_encounter" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "face_to_face_encounter" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "level_of_care_period_org" ON "level_of_care_period";--> statement-breakpoint
CREATE POLICY "level_of_care_period_org" ON "level_of_care_period"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "level_of_care_period" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "level_of_care_period" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "revocation_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "revocation_event_org" ON "revocation_event";--> statement-breakpoint
CREATE POLICY "revocation_event_org" ON "revocation_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "revocation_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "revocation_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "transfer_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "transfer_event_org" ON "transfer_event";--> statement-breakpoint
CREATE POLICY "transfer_event_org" ON "transfer_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "transfer_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "transfer_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discharge_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "discharge_event_org" ON "discharge_event";--> statement-breakpoint
CREATE POLICY "discharge_event_org" ON "discharge_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "discharge_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "discharge_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "notice_of_rights_acknowledgment_org" ON "notice_of_rights_acknowledgment";--> statement-breakpoint
CREATE POLICY "notice_of_rights_acknowledgment_org" ON "notice_of_rights_acknowledgment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notice_of_rights_acknowledgment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "notice_of_rights_acknowledgment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "compliance_window" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "compliance_window_org" ON "compliance_window";--> statement-breakpoint
CREATE POLICY "compliance_window_org" ON "compliance_window"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "compliance_window" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "compliance_window" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table PHI/PII denylist, §3.7).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_referral() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_dob_at_receipt', 'patient_name_at_receipt', 'referrer_phone', 'referring_dx_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_dob_at_receipt', 'patient_name_at_receipt', 'referrer_phone', 'referring_dx_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'referral.' || lower(TG_OP),
    'referral',
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
ALTER FUNCTION audit_phi_write_referral() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_referral" AFTER INSERT OR UPDATE OR DELETE ON referral
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_referral();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_admission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['hold_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['hold_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'admission.' || lower(TG_OP),
    'admission',
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
ALTER FUNCTION audit_phi_write_admission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_admission" AFTER INSERT OR UPDATE OR DELETE ON admission
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_admission();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_election_period() RETURNS trigger
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
    'election_period.' || lower(TG_OP),
    'election_period',
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
ALTER FUNCTION audit_phi_write_election_period() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_election_period" AFTER INSERT OR UPDATE OR DELETE ON election_period
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_election_period();--> statement-breakpoint
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
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_name_at_signing', 'state_addendum']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_name_at_signing', 'state_addendum']::text[]) ELSE NULL END;
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
CREATE TRIGGER "trg_audit_election_statement" AFTER INSERT OR UPDATE OR DELETE ON election_statement
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_election_statement();--> statement-breakpoint
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
    THEN audit_scrub(to_jsonb(OLD), ARRAY['late_reason', 'narrative']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['late_reason', 'narrative']::text[]) ELSE NULL END;
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
CREATE TRIGGER "trg_audit_certification_of_terminal_illness" AFTER INSERT OR UPDATE OR DELETE ON certification_of_terminal_illness
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_certification_of_terminal_illness();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_face_to_face_encounter() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['attestation_narrative', 'window_override_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['attestation_narrative', 'window_override_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'f2f.' || lower(TG_OP),
    'f2f',
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
ALTER FUNCTION audit_phi_write_face_to_face_encounter() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_face_to_face_encounter" AFTER INSERT OR UPDATE OR DELETE ON face_to_face_encounter
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_face_to_face_encounter();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_level_of_care_period() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'level_of_care.' || lower(TG_OP),
    'level_of_care',
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
ALTER FUNCTION audit_phi_write_level_of_care_period() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_level_of_care_period" AFTER INSERT OR UPDATE OR DELETE ON level_of_care_period
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_level_of_care_period();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_revocation_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['narrative']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['narrative']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'revocation.' || lower(TG_OP),
    'revocation',
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
ALTER FUNCTION audit_phi_write_revocation_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_revocation_event" AFTER INSERT OR UPDATE OR DELETE ON revocation_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_revocation_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_transfer_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['narrative']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['narrative']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'transfer.' || lower(TG_OP),
    'transfer',
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
ALTER FUNCTION audit_phi_write_transfer_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_transfer_event" AFTER INSERT OR UPDATE OR DELETE ON transfer_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_transfer_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discharge_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['for_cause_reason', 'narrative']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['for_cause_reason', 'narrative']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discharge.' || lower(TG_OP),
    'discharge',
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
ALTER FUNCTION audit_phi_write_discharge_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discharge_event" AFTER INSERT OR UPDATE OR DELETE ON discharge_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discharge_event();--> statement-breakpoint
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
CREATE TRIGGER "trg_audit_notice_of_rights_acknowledgment" AFTER INSERT OR UPDATE OR DELETE ON notice_of_rights_acknowledgment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_notice_of_rights_acknowledgment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_compliance_window() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['close_reason', 'override_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['close_reason', 'override_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'compliance_window.' || lower(TG_OP),
    'compliance_window',
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
ALTER FUNCTION audit_phi_write_compliance_window() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_compliance_window" AFTER INSERT OR UPDATE OR DELETE ON compliance_window
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_compliance_window();
