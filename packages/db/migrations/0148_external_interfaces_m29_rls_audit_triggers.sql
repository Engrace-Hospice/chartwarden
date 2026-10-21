-- M29 External Interfaces §3.5/§3.6 — RLS + grants on all eleven owned tables and the M4 write-audit
-- trigger on each. Tables land in 0144 (six unpartitioned), 0145 (three received_at-partitioned), 0146
-- (hl7_message_outbound) and 0147 (hl7_inbound_proposal).
--
-- 1. RLS (§3.5 / ADR-0010 D2) — TWO SHAPES.
--    • TENANT-SCOPED (nine): external_feed, external_feed_credential, external_feed_health,
--      lab_observation_inbound_link, hl7_message_inbound, hl7_message_outbound, hl7_inbound_proposal,
--      lab_observation, lab_observation_value. One FOR ALL policy keyed ONLY on app.org_id, set by
--      withOrgContext(). wardenx_app gets SELECT/INSERT/UPDATE and NO DELETE — the §3.7 eraser SHREDS in
--      place (destroy the DEK, re-encrypt the candidate to null, tombstone the feed) rather than deleting,
--      because the rows ARE the §164.528 disclosure-accounting evidence. For the five partitioned tables the
--      policy + grants are declared on the PARTITIONED PARENT only; they propagate to every partition (PG11+,
--      the M32 ai_invocation / M28 fhir_client_session precedent).
--    • PLATFORM-SHARED (two): nppes_provider, nppes_sync_run, no organization_id. FOR SELECT USING (true) TO
--      wardenx_app (any tenant reads the public NPPES directory); writes only via wardenx_admin (the M28
--      fhir_capability_snapshot / M38 code_system precedent). The spec §3.5 sketch gates writes on an
--      app.role predicate, but the canonical-RLS-variable rule (ADR-0010 D2, arch:tenancy) permits ONLY
--      app.org_id in a policy — so the equivalent control is the role grant; architecture wins over the spec.
--
-- 2. M4 write-audit triggers (§3.6).
--    Seven tables get GENERATED scrubbing functions that resolve organization_id from the ROW and hard-code
--    the parent's name into resource_kind/event_type — the last point is why lab_observation /
--    lab_observation_value get a generated function DESPITE an empty denylist: M1's baseline trigger stamps
--    TG_TABLE_NAME, which on a partitioned write is the dated PARTITION, so the audit trail would rename
--    itself every month (the M32 ai_token_ledger lesson). The v_cols lists mirror `M29_AUDIT_DENYLIST` in
--    @chartwarden/types VERBATIM so the code-side view and the DB-side scrub cannot drift.
--        external_feed_credential   secret_cipher                                  (compliance)
--        hl7_message_inbound        payload_cipher, parsed_segments_cipher         (compliance, partitioned)
--        hl7_message_outbound       payload_cipher, ack_payload_cipher             (compliance, partitioned)
--        hl7_inbound_proposal       proposed_patient_candidate                     (compliance, partitioned)
--        lab_observation            (empty — generated only because PARTITIONED)   (compliance, partitioned)
--        lab_observation_value      (empty — generated only because PARTITIONED)   (compliance, partitioned)
--        nppes_provider             (empty — generated to stamp 'operational')     (operational, no org column)
--    The remaining four (external_feed, external_feed_health, lab_observation_inbound_link, nppes_sync_run)
--    carry empty denylists, file `compliance`, and are unpartitioned, so they use M1's baseline
--    `wardenx_audit_trigger()` unchanged (the M28 fhir_client / M21 supply_item precedent).
--    external_feed_health has no synthetic id (composite PK) so the baseline records a NULL resource_id —
--    the honest answer; nppes_sync_run has no organization_id so the baseline resolves the (absent) org from
--    the session and records NULL — likewise honest.

-- ============================================================================================
-- 1. RLS policies + grants (§3.5).
-- ============================================================================================
-- TENANT-SCOPED: canonical app.org_id isolation, no DELETE for wardenx_app.--> statement-breakpoint
ALTER TABLE "external_feed" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "external_feed_org" ON "external_feed";
CREATE POLICY "external_feed_org" ON "external_feed"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "external_feed" TO wardenx_app;
GRANT ALL ON "external_feed" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "external_feed_credential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "external_feed_credential_org" ON "external_feed_credential";
CREATE POLICY "external_feed_credential_org" ON "external_feed_credential"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "external_feed_credential" TO wardenx_app;
GRANT ALL ON "external_feed_credential" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "external_feed_health" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "external_feed_health_org" ON "external_feed_health";
CREATE POLICY "external_feed_health_org" ON "external_feed_health"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "external_feed_health" TO wardenx_app;
GRANT ALL ON "external_feed_health" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "lab_observation_inbound_link" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_observation_inbound_link_org" ON "lab_observation_inbound_link";
CREATE POLICY "lab_observation_inbound_link_org" ON "lab_observation_inbound_link"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "lab_observation_inbound_link" TO wardenx_app;
GRANT ALL ON "lab_observation_inbound_link" TO wardenx_admin;--> statement-breakpoint
-- Declared on the PARTITIONED PARENT; propagates to every partition.--> statement-breakpoint
ALTER TABLE "hl7_message_inbound" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hl7_message_inbound_org" ON "hl7_message_inbound";
CREATE POLICY "hl7_message_inbound_org" ON "hl7_message_inbound"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hl7_message_inbound" TO wardenx_app;
GRANT ALL ON "hl7_message_inbound" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hl7_message_outbound" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hl7_message_outbound_org" ON "hl7_message_outbound";
CREATE POLICY "hl7_message_outbound_org" ON "hl7_message_outbound"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hl7_message_outbound" TO wardenx_app;
GRANT ALL ON "hl7_message_outbound" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hl7_inbound_proposal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hl7_inbound_proposal_org" ON "hl7_inbound_proposal";
CREATE POLICY "hl7_inbound_proposal_org" ON "hl7_inbound_proposal"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hl7_inbound_proposal" TO wardenx_app;
GRANT ALL ON "hl7_inbound_proposal" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "lab_observation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_observation_org" ON "lab_observation";
CREATE POLICY "lab_observation_org" ON "lab_observation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "lab_observation" TO wardenx_app;
GRANT ALL ON "lab_observation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "lab_observation_value" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_observation_value_org" ON "lab_observation_value";
CREATE POLICY "lab_observation_value_org" ON "lab_observation_value"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "lab_observation_value" TO wardenx_app;
GRANT ALL ON "lab_observation_value" TO wardenx_admin;--> statement-breakpoint
-- PLATFORM-SHARED: read-all within any tenant, writes via wardenx_admin only.--> statement-breakpoint
-- Read-all to wardenx_app (SELECT only); the nightly sync writes as wardenx_admin under a permissive
-- write policy (§3.5). Two roles, two policies — NOT two FOR ALL on the same role, so no OR-combine.--> statement-breakpoint
ALTER TABLE "nppes_provider" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nppes_provider_read" ON "nppes_provider";
CREATE POLICY "nppes_provider_read" ON "nppes_provider"
  FOR SELECT TO wardenx_app USING (true);
DROP POLICY IF EXISTS "nppes_provider_write" ON "nppes_provider";
CREATE POLICY "nppes_provider_write" ON "nppes_provider"
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);
GRANT SELECT ON "nppes_provider" TO wardenx_app;
GRANT ALL ON "nppes_provider" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "nppes_sync_run" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nppes_sync_run_read" ON "nppes_sync_run";
CREATE POLICY "nppes_sync_run_read" ON "nppes_sync_run"
  FOR SELECT TO wardenx_app USING (true);
DROP POLICY IF EXISTS "nppes_sync_run_write" ON "nppes_sync_run";
CREATE POLICY "nppes_sync_run_write" ON "nppes_sync_run"
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);
GRANT SELECT ON "nppes_sync_run" TO wardenx_app;
GRANT ALL ON "nppes_sync_run" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. M4 write-audit triggers (§3.6).
-- ============================================================================================
-- 2a. The four empty-denylist / unpartitioned tables use M1's baseline trigger unchanged.--> statement-breakpoint
CREATE TRIGGER "external_feed_audit" AFTER INSERT OR UPDATE OR DELETE ON external_feed
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "external_feed_health_audit" AFTER INSERT OR UPDATE OR DELETE ON external_feed_health
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "lab_observation_inbound_link_audit" AFTER INSERT OR UPDATE OR DELETE ON lab_observation_inbound_link
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "nppes_sync_run_audit" AFTER INSERT OR UPDATE OR DELETE ON nppes_sync_run
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- 2b. external_feed_credential — denylist secret_cipher (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_external_feed_credential() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['secret_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'external_feed_credential.' || lower(TG_OP),
    'external_feed_credential',
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
ALTER FUNCTION audit_phi_write_external_feed_credential() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_external_feed_credential" AFTER INSERT OR UPDATE OR DELETE ON external_feed_credential
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_external_feed_credential();--> statement-breakpoint

-- 2c. hl7_message_inbound — denylist payload_cipher + parsed_segments_cipher, PARTITIONED (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hl7_message_inbound() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload_cipher','parsed_segments_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hl7_message_inbound.' || lower(TG_OP),
    'hl7_message_inbound',
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
ALTER FUNCTION audit_phi_write_hl7_message_inbound() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hl7_message_inbound" AFTER INSERT OR UPDATE OR DELETE ON hl7_message_inbound
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hl7_message_inbound();--> statement-breakpoint

-- 2d. hl7_message_outbound — denylist payload_cipher + ack_payload_cipher, PARTITIONED (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hl7_message_outbound() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload_cipher','ack_payload_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hl7_message_outbound.' || lower(TG_OP),
    'hl7_message_outbound',
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
ALTER FUNCTION audit_phi_write_hl7_message_outbound() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hl7_message_outbound" AFTER INSERT OR UPDATE OR DELETE ON hl7_message_outbound
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hl7_message_outbound();--> statement-breakpoint

-- 2e. hl7_inbound_proposal — denylist proposed_patient_candidate, PARTITIONED (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hl7_inbound_proposal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['proposed_patient_candidate']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hl7_inbound_proposal.' || lower(TG_OP),
    'hl7_inbound_proposal',
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
ALTER FUNCTION audit_phi_write_hl7_inbound_proposal() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hl7_inbound_proposal" AFTER INSERT OR UPDATE OR DELETE ON hl7_inbound_proposal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hl7_inbound_proposal();--> statement-breakpoint

-- 2f. lab_observation — empty denylist but PARTITIONED, so parent name is hard-coded (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_lab_observation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'lab_observation.' || lower(TG_OP),
    'lab_observation',
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
ALTER FUNCTION audit_phi_write_lab_observation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_lab_observation" AFTER INSERT OR UPDATE OR DELETE ON lab_observation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_lab_observation();--> statement-breakpoint

-- 2g. lab_observation_value — empty denylist but PARTITIONED, parent name hard-coded (compliance).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_lab_observation_value() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'lab_observation_value.' || lower(TG_OP),
    'lab_observation_value',
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
ALTER FUNCTION audit_phi_write_lab_observation_value() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_lab_observation_value" AFTER INSERT OR UPDATE OR DELETE ON lab_observation_value
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_lab_observation_value();--> statement-breakpoint

-- 2h. nppes_provider — platform-shared (NO organization_id): org from session, retention 'operational'
--     (public-directory record, rebuildable from a re-sync). No uuid id (PK is the char(10) NPI), so
--     resource_id is NULL — the (npi) is the identity.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_nppes_provider() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    NULLIF(current_setting('app.org_id', true), '')::uuid,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'nppes_provider.' || lower(TG_OP),
    'nppes_provider',
    NULL,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('npi', COALESCE(NEW.npi, OLD.npi)),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_nppes_provider() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_nppes_provider" AFTER INSERT OR UPDATE OR DELETE ON nppes_provider
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_nppes_provider();
