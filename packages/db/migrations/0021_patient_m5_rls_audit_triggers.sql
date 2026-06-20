-- M5 Patient & Demographics §3.6 (org-scoped RLS + grants) + §3.7 (write-audit triggers via
-- the M4 generator) + §3.8 (external-resolution seam lookup indexes) — M5-T05.
--
-- Tables/enums/indexes/FKs/CHECKs land in 0020 (drizzle-generated). This migration locks the
-- per-table RLS (standard app.org_id org-scope — all 16 tables carry organization_id, M05-F04),
-- the §3.6 grants (no-DELETE on the patient spine + history tables; DELETE only on caregiver/
-- emergency-contact rotation; patient_merge append-only with column-level unmerge UPDATE), the
-- per-table write-audit triggers (sensitive columns on the DENYLIST so PHI/ciphertext never lands
-- in the audit diff — §3.7), and the §3.8 functional seam indexes for the M29 T-29.05 cascade.
-- Every M5 table is PHI org-scoped → gets BOTH an RLS policy and an audit trigger (arch:gaps floor).

-- 0. M4 write-audit append path — idempotent re-assertion (already from 0012–0019).
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint

-- ============================================================================================
-- §3.6 RLS POLICIES + GRANTS (standard org-scope on app.org_id; RBAC/ABAC is the app story)
-- ============================================================================================
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_org" ON "patient"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_identifier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_identifier_org" ON "patient_identifier"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_identifier" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_identifier" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_name_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_name_alias_org" ON "patient_name_alias"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_name_alias" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_name_alias" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_address_org" ON "patient_address"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_address" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_address" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_phone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_phone_org" ON "patient_phone"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_phone" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_phone" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_email" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_email_org" ON "patient_email"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_email" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_email" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_payer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_payer_org" ON "patient_payer"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_payer" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_payer" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "caregiver" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "caregiver_org" ON "caregiver"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "caregiver" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "caregiver" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_caregiver" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_caregiver_org" ON "patient_caregiver"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "patient_caregiver" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_caregiver" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "emergency_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "emergency_contact_org" ON "emergency_contact"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "emergency_contact" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "emergency_contact" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_communication_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_communication_preference_org" ON "patient_communication_preference"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_communication_preference" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_communication_preference" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_assignment_org" ON "patient_assignment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_assignment" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_assignment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_privacy_flag_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_privacy_flag_snapshot_org" ON "patient_privacy_flag_snapshot"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_privacy_flag_snapshot" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_privacy_flag_snapshot" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_match_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_match_review_org" ON "patient_match_review"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_match_review" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_match_review" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_merge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_merge_org" ON "patient_merge"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "patient_merge" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE (unmerged_at, unmerged_by) ON "patient_merge" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_merge" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "patient_amendment_request_org" ON "patient_amendment_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_amendment_request" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_amendment_request" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- §3.7 WRITE-AUDIT TRIGGERS — M4 generateAuditTrigger() output (sensitive columns on the denylist)
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_patient() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['legal_first_name', 'legal_last_name', 'legal_middle_name']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['legal_first_name', 'legal_last_name', 'legal_middle_name']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient.' || lower(TG_OP),
    'patient',
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
ALTER FUNCTION audit_phi_write_patient() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient" AFTER INSERT OR UPDATE OR DELETE ON patient
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_identifier() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['value', 'value_encrypted', 'value_last4']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['value', 'value_encrypted', 'value_last4']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_identifier.' || lower(TG_OP),
    'patient_identifier',
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
ALTER FUNCTION audit_phi_write_patient_identifier() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_identifier" AFTER INSERT OR UPDATE OR DELETE ON patient_identifier
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_identifier();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_name_alias() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['first_name', 'full_name', 'last_name']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['first_name', 'full_name', 'last_name']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_name_alias.' || lower(TG_OP),
    'patient_name_alias',
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
ALTER FUNCTION audit_phi_write_patient_name_alias() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_name_alias" AFTER INSERT OR UPDATE OR DELETE ON patient_name_alias
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_name_alias();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_address() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['geocode_lat', 'geocode_lng', 'line1', 'line2']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['geocode_lat', 'geocode_lng', 'line1', 'line2']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_address.' || lower(TG_OP),
    'patient_address',
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
ALTER FUNCTION audit_phi_write_patient_address() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_address" AFTER INSERT OR UPDATE OR DELETE ON patient_address
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_address();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_phone() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['e164']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['e164']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_phone.' || lower(TG_OP),
    'patient_phone',
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
ALTER FUNCTION audit_phi_write_patient_phone() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_phone" AFTER INSERT OR UPDATE OR DELETE ON patient_phone
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_phone();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_email() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['email']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['email']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_email.' || lower(TG_OP),
    'patient_email',
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
ALTER FUNCTION audit_phi_write_patient_email() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_email" AFTER INSERT OR UPDATE OR DELETE ON patient_email
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_email();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_payer() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['subscriber_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['subscriber_id']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_payer.' || lower(TG_OP),
    'patient_payer',
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
ALTER FUNCTION audit_phi_write_patient_payer() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_payer" AFTER INSERT OR UPDATE OR DELETE ON patient_payer
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_payer();
CREATE OR REPLACE FUNCTION audit_phi_write_caregiver() RETURNS trigger
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
    'caregiver.' || lower(TG_OP),
    'caregiver',
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
ALTER FUNCTION audit_phi_write_caregiver() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_caregiver" AFTER INSERT OR UPDATE OR DELETE ON caregiver
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_caregiver();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_caregiver() RETURNS trigger
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
    'patient_caregiver.' || lower(TG_OP),
    'patient_caregiver',
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
ALTER FUNCTION audit_phi_write_patient_caregiver() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_caregiver" AFTER INSERT OR UPDATE OR DELETE ON patient_caregiver
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_caregiver();
CREATE OR REPLACE FUNCTION audit_phi_write_emergency_contact() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['email', 'phone']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['email', 'phone']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'emergency_contact.' || lower(TG_OP),
    'emergency_contact',
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
ALTER FUNCTION audit_phi_write_emergency_contact() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_emergency_contact" AFTER INSERT OR UPDATE OR DELETE ON emergency_contact
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_emergency_contact();
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
ALTER FUNCTION audit_phi_write_patient_communication_preference() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_communication_preference" AFTER INSERT OR UPDATE OR DELETE ON patient_communication_preference
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_communication_preference();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_assignment() RETURNS trigger
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
    'patient_assignment.' || lower(TG_OP),
    'patient_assignment',
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
ALTER FUNCTION audit_phi_write_patient_assignment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_assignment" AFTER INSERT OR UPDATE OR DELETE ON patient_assignment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_assignment();
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
ALTER FUNCTION audit_phi_write_patient_privacy_flag_snapshot() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_privacy_flag_snapshot" AFTER INSERT OR UPDATE OR DELETE ON patient_privacy_flag_snapshot
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_privacy_flag_snapshot();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_match_review() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['candidate_incoming', 'feature_breakdown']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['candidate_incoming', 'feature_breakdown']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_match_review.' || lower(TG_OP),
    'patient_match_review',
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
ALTER FUNCTION audit_phi_write_patient_match_review() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_match_review" AFTER INSERT OR UPDATE OR DELETE ON patient_match_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_match_review();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_merge() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['merged_field_diff']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['merged_field_diff']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_merge.' || lower(TG_OP),
    'patient_merge',
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
ALTER FUNCTION audit_phi_write_patient_merge() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_merge" AFTER INSERT OR UPDATE OR DELETE ON patient_merge
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_merge();
CREATE OR REPLACE FUNCTION audit_phi_write_patient_amendment_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['denial_reason', 'requested_changes', 'statement_of_disagreement']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['denial_reason', 'requested_changes', 'statement_of_disagreement']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_amendment_request.' || lower(TG_OP),
    'patient_amendment_request',
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
ALTER FUNCTION audit_phi_write_patient_amendment_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_amendment_request" AFTER INSERT OR UPDATE OR DELETE ON patient_amendment_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_amendment_request();

-- ============================================================================================
-- §3.8 EXTERNAL-RESOLUTION SEAM LOOKUP INDEXES (the M29 T-29.05 cascade SLO; functional indexes
-- Drizzle cannot express, so they live here rather than in the schema .ts).
-- ============================================================================================
-- L2: external MRN lookup by (org, assigning_authority, value)
CREATE INDEX idx_pid_external_mrn_lookup ON patient_identifier (organization_id, issuer, value)
  WHERE kind IN ('partner_mrn', 'prior_mrn', 'hospice_external');--> statement-breakpoint
-- L3: SSN-last4 lookup (the JOIN filters by patient.dob at runtime)
CREATE INDEX idx_pid_ssn_last4 ON patient_identifier (organization_id, value_last4)
  WHERE kind = 'ssn' AND value_last4 IS NOT NULL;--> statement-breakpoint
-- L4: exact name + DOB + sex (case-insensitive name)
CREATE INDEX idx_patient_name_dob_sex ON patient
  (organization_id, LOWER(legal_last_name), LOWER(legal_first_name), dob, sex_assigned_at_birth);--> statement-breakpoint
-- L5: loose name + DOB (last name + first initial + DOB)
CREATE INDEX idx_patient_loose_name ON patient
  (organization_id, LOWER(legal_last_name), SUBSTRING(LOWER(legal_first_name), 1, 1), dob);--> statement-breakpoint
