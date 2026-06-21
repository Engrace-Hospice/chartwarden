-- M8 Encounters & Visit Notes §3.3 (RLS + grants) + §3.4 (write-audit triggers) — M8-T03.
--
-- Tables/enums/indexes/FKs land in 0030 (drizzle-generated). This migration locks:
--   • standard app.org_id org-scope RLS on all ten M8 tables (ADR-0010 D2: row visibility keys ONLY
--     on app.org_id, set by withOrgContext()); the three-column tenancy (organization_id +
--     provider_entity_id + location_id) is denormalized on every owned table for ABAC narrowing, but
--     the RLS pivot is organization_id alone (ARCH-067 order);
--   • the §3.6 grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (encounters are
--     never deleted: a genuine error becomes status=voided, terminal; child rows clear via the
--     admin-run destruction eraseFn, not an app DELETE);
--   • the M4 write-audit trigger (generateAuditTrigger) on every table, with the §3.1/§8.1 PHI denylist
--     so free-text reason/narrative columns (late-entry/override/void reasons, addendum reason,
--     supervisor-release reason, vitals CNI reason, mileage override reason) and the encrypted HearthNote
--     cipher/diff columns never land in the audit diff (the trigger records the write + a <changed>
--     marker, never the PHI value). All ten carry organization_id, so all ten get BOTH an RLS policy and
--     a trigger (arch:gaps phi-guards floor). Every M8 table has a UUID PK + organization_id, so each
--     takes the M4 generator (no M1 baseline-trigger fallback needed). Retention class 'compliance'
--     (CoP 418.104, 6-year clinical-record retention; §3.4 / spec §11).--> statement-breakpoint
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint
-- 1. Org-scope RLS + grants (standard app.org_id; §3.3). No DELETE — supersession via status=voided.--> statement-breakpoint
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "encounter_org" ON "encounter";
CREATE POLICY "encounter_org" ON "encounter"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "encounter" TO wardenx_app;
GRANT ALL ON "encounter" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "encounter_addendum_org" ON "encounter_addendum";
CREATE POLICY "encounter_addendum_org" ON "encounter_addendum"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "encounter_addendum" TO wardenx_app;
GRANT ALL ON "encounter_addendum" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "encounter_signature" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "encounter_signature_org" ON "encounter_signature";
CREATE POLICY "encounter_signature_org" ON "encounter_signature"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "encounter_signature" TO wardenx_app;
GRANT ALL ON "encounter_signature" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "encounter_care_plan_link_org" ON "encounter_care_plan_link";
CREATE POLICY "encounter_care_plan_link_org" ON "encounter_care_plan_link"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "encounter_care_plan_link" TO wardenx_app;
GRANT ALL ON "encounter_care_plan_link" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "cosignature_request" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cosignature_request_org" ON "cosignature_request";
CREATE POLICY "cosignature_request_org" ON "cosignature_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "cosignature_request" TO wardenx_app;
GRANT ALL ON "cosignature_request" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "vitals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vitals_org" ON "vitals";
CREATE POLICY "vitals_org" ON "vitals"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "vitals" TO wardenx_app;
GRANT ALL ON "vitals" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "mileage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mileage_org" ON "mileage";
CREATE POLICY "mileage_org" ON "mileage"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "mileage" TO wardenx_app;
GRANT ALL ON "mileage" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hearthnote_selection_org" ON "hearthnote_selection";
CREATE POLICY "hearthnote_selection_org" ON "hearthnote_selection"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hearthnote_selection" TO wardenx_app;
GRANT ALL ON "hearthnote_selection" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hearthnote_assembled_output_org" ON "hearthnote_assembled_output";
CREATE POLICY "hearthnote_assembled_output_org" ON "hearthnote_assembled_output"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hearthnote_assembled_output" TO wardenx_app;
GRANT ALL ON "hearthnote_assembled_output" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hearthnote_llm_modification_org" ON "hearthnote_llm_modification";
CREATE POLICY "hearthnote_llm_modification_org" ON "hearthnote_llm_modification"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hearthnote_llm_modification" TO wardenx_app;
GRANT ALL ON "hearthnote_llm_modification" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table PHI denylist, §3.4 / §8.1).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['administrative_override_reason', 'evv_missing_reason', 'late_entry_reason', 'significant_late_override_reason', 'voided_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['administrative_override_reason', 'evv_missing_reason', 'late_entry_reason', 'significant_late_override_reason', 'voided_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'encounter.' || lower(TG_OP),
    'encounter',
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
ALTER FUNCTION audit_phi_write_encounter() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter" AFTER INSERT OR UPDATE OR DELETE ON encounter
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_addendum() RETURNS trigger
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
    'encounter_addendum.' || lower(TG_OP),
    'encounter_addendum',
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
ALTER FUNCTION audit_phi_write_encounter_addendum() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_addendum" AFTER INSERT OR UPDATE OR DELETE ON encounter_addendum
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_addendum();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_signature() RETURNS trigger
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
    'encounter_signature.' || lower(TG_OP),
    'encounter_signature',
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
ALTER FUNCTION audit_phi_write_encounter_signature() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_signature" AFTER INSERT OR UPDATE OR DELETE ON encounter_signature
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_signature();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_care_plan_link() RETURNS trigger
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
    'encounter_care_plan_link.' || lower(TG_OP),
    'encounter_care_plan_link',
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
ALTER FUNCTION audit_phi_write_encounter_care_plan_link() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_care_plan_link" AFTER INSERT OR UPDATE OR DELETE ON encounter_care_plan_link
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_care_plan_link();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_cosignature_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['supervisor_released_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['supervisor_released_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'cosignature_request.' || lower(TG_OP),
    'cosignature_request',
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
ALTER FUNCTION audit_phi_write_cosignature_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cosignature_request" AFTER INSERT OR UPDATE OR DELETE ON cosignature_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cosignature_request();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_vitals() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['clinically_not_indicated_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['clinically_not_indicated_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'vitals.' || lower(TG_OP),
    'vitals',
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
ALTER FUNCTION audit_phi_write_vitals() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_vitals" AFTER INSERT OR UPDATE OR DELETE ON vitals
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_vitals();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_mileage() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['manual_override_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['manual_override_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'mileage.' || lower(TG_OP),
    'mileage',
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
ALTER FUNCTION audit_phi_write_mileage() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mileage" AFTER INSERT OR UPDATE OR DELETE ON mileage
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mileage();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hearthnote_selection() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['free_text_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['free_text_cipher']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hearthnote_selection.' || lower(TG_OP),
    'hearthnote_selection',
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
ALTER FUNCTION audit_phi_write_hearthnote_selection() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hearthnote_selection" AFTER INSERT OR UPDATE OR DELETE ON hearthnote_selection
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hearthnote_selection();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hearthnote_assembled_output() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['final_cipher', 'layer1_cipher', 'layer2_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['final_cipher', 'layer1_cipher', 'layer2_cipher']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hearthnote_assembled_output.' || lower(TG_OP),
    'hearthnote_assembled_output',
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
ALTER FUNCTION audit_phi_write_hearthnote_assembled_output() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hearthnote_assembled_output" AFTER INSERT OR UPDATE OR DELETE ON hearthnote_assembled_output
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hearthnote_assembled_output();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hearthnote_llm_modification() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['diff_json', 'per_passage_decisions']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['diff_json', 'per_passage_decisions']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hearthnote_llm_modification.' || lower(TG_OP),
    'hearthnote_llm_modification',
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
ALTER FUNCTION audit_phi_write_hearthnote_llm_modification() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hearthnote_llm_modification" AFTER INSERT OR UPDATE OR DELETE ON hearthnote_llm_modification
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hearthnote_llm_modification();
