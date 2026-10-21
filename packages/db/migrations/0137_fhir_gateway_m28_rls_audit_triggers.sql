-- M28 FHIR Gateway §3.5/§3.6 — RLS + grants on all eight owned tables and the M4 write-audit trigger on
-- each. Tables land in 0134 (six unpartitioned), 0135 (`fhir_client_session`) and 0136
-- (`fhir_inbound_resource`).
--
-- 1. RLS (§3.5 / ADR-0010 D2) — TWO SHAPES.
--
--    • TENANT-SCOPED (seven): tenant_fhir_config, fhir_client, fhir_client_credential,
--      fhir_client_session, fhir_bulk_export_job, fhir_bulk_export_artifact, fhir_inbound_resource. One
--      `FOR ALL` policy keyed ONLY on app.org_id, set by withOrgContext(). wardenx_app gets
--      SELECT/INSERT/UPDATE and NO DELETE — the §3.7 eraser SHREDS in place (zero the cipher, replace the
--      payload with the destroyed sentinel, soft-delete the client) rather than deleting rows, because the
--      rows ARE the §164.528 disclosure-accounting evidence. For the two partitioned tables the policy and
--      grants are declared on the PARTITIONED PARENT only; they propagate to every partition (PG11+, the
--      M32 ai_invocation / ai_token_ledger precedent).
--
--    • PLATFORM-SHARED (one): fhir_capability_snapshot, no organization_id. `FOR SELECT USING (true)` to
--      wardenx_app (a client must read the conformance statement to speak to the gateway); wardenx_app
--      gets SELECT and NOTHING ELSE, so it is writable only by wardenx_admin (the M32 ai_capability / M38
--      code_system / M22 form_template precedent). The spec §3.5 gates writes on an app.role='platform_ops'
--      session predicate, but the canonical-RLS-variable rule (ADR-0010 D2, arch:tenancy) permits ONLY
--      app.org_id in a policy — so the equivalent control is the role grant, and architecture wins over the
--      module spec.
--
-- 2. M4 write-audit triggers (§3.6).
--
--    Four tables carry a per-table denylist or are partitioned, so they get GENERATED scrubbing functions
--    (the M4 §3.6 generator shape) that resolve organization_id from the ROW and hard-code the parent's
--    name into resource_kind/event_type — the last point is why fhir_client_session gets a generated
--    function DESPITE an empty denylist: M1's baseline trigger stamps `TG_TABLE_NAME`, which on a
--    partitioned write is the dated PARTITION, so the audit trail would rename itself every month (the M32
--    ai_token_ledger lesson).
--        tenant_fhir_config       cursor_signing_key_cipher                          (compliance)
--        fhir_client_credential   secret_cipher, secret_digest_sha256                (compliance)
--        fhir_client_session      (empty — generated only because PARTITIONED)       (operational)
--        fhir_inbound_resource    payload                                            (compliance)
--    The v_cols lists mirror `M28_AUDIT_DENYLIST` in @chartwarden/types VERBATIM so the code-side view and the
--    DB-side scrub cannot drift.
--
--    The remaining four (fhir_client, fhir_bulk_export_job, fhir_bulk_export_artifact,
--    fhir_capability_snapshot) carry empty denylists, file `compliance`, and are unpartitioned, so they use
--    M1's baseline `wardenx_audit_trigger()` unchanged (the M32 ai_capability / M21 supply_item precedent).
--    fhir_capability_snapshot has no organization_id column at all; the baseline function resolves the org
--    from the SESSION and records NULL when a platform-admin write has no tenant context — the honest
--    answer, not a defect.

-- ============================================================================================
-- 1. RLS policies + grants (§3.5).
-- ============================================================================================
-- TENANT-SCOPED: canonical app.org_id isolation, no DELETE for wardenx_app.--> statement-breakpoint
ALTER TABLE "tenant_fhir_config" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_fhir_config_org" ON "tenant_fhir_config";
CREATE POLICY "tenant_fhir_config_org" ON "tenant_fhir_config"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "tenant_fhir_config" TO wardenx_app;
GRANT ALL ON "tenant_fhir_config" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "fhir_client" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_client_org" ON "fhir_client";
CREATE POLICY "fhir_client_org" ON "fhir_client"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_client" TO wardenx_app;
GRANT ALL ON "fhir_client" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "fhir_client_credential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_client_credential_org" ON "fhir_client_credential";
CREATE POLICY "fhir_client_credential_org" ON "fhir_client_credential"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_client_credential" TO wardenx_app;
GRANT ALL ON "fhir_client_credential" TO wardenx_admin;--> statement-breakpoint
-- Declared on the PARTITIONED PARENT; propagates to every partition.--> statement-breakpoint
ALTER TABLE "fhir_client_session" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_client_session_org" ON "fhir_client_session";
CREATE POLICY "fhir_client_session_org" ON "fhir_client_session"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_client_session" TO wardenx_app;
GRANT ALL ON "fhir_client_session" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "fhir_bulk_export_job" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_bulk_export_job_org" ON "fhir_bulk_export_job";
CREATE POLICY "fhir_bulk_export_job_org" ON "fhir_bulk_export_job"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_bulk_export_job" TO wardenx_app;
GRANT ALL ON "fhir_bulk_export_job" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "fhir_bulk_export_artifact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_bulk_export_artifact_org" ON "fhir_bulk_export_artifact";
CREATE POLICY "fhir_bulk_export_artifact_org" ON "fhir_bulk_export_artifact"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_bulk_export_artifact" TO wardenx_app;
GRANT ALL ON "fhir_bulk_export_artifact" TO wardenx_admin;--> statement-breakpoint
-- Declared on the PARTITIONED PARENT; propagates to every partition.--> statement-breakpoint
ALTER TABLE "fhir_inbound_resource" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_inbound_resource_org" ON "fhir_inbound_resource";
CREATE POLICY "fhir_inbound_resource_org" ON "fhir_inbound_resource"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "fhir_inbound_resource" TO wardenx_app;
GRANT ALL ON "fhir_inbound_resource" TO wardenx_admin;--> statement-breakpoint
-- PLATFORM-SHARED: read-all within any tenant, writes via wardenx_admin only.--> statement-breakpoint
ALTER TABLE "fhir_capability_snapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_capability_snapshot_read" ON "fhir_capability_snapshot";
CREATE POLICY "fhir_capability_snapshot_read" ON "fhir_capability_snapshot"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "fhir_capability_snapshot" TO wardenx_app;
GRANT ALL ON "fhir_capability_snapshot" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. M4 write-audit triggers (§3.6).
-- ============================================================================================
-- 2a. The four empty-denylist / unpartitioned tables use M1's baseline trigger unchanged.--> statement-breakpoint
CREATE TRIGGER "fhir_client_audit" AFTER INSERT OR UPDATE OR DELETE ON fhir_client
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "fhir_bulk_export_job_audit" AFTER INSERT OR UPDATE OR DELETE ON fhir_bulk_export_job
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "fhir_bulk_export_artifact_audit" AFTER INSERT OR UPDATE OR DELETE ON fhir_bulk_export_artifact
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "fhir_capability_snapshot_audit" AFTER INSERT OR UPDATE OR DELETE ON fhir_capability_snapshot
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- 2b. The four denylisted / partitioned tables get generated scrubbing functions — org from the ROW.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_fhir_config() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['cursor_signing_key_cipher']::text[];
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
    'tenant_fhir_config.' || lower(TG_OP),
    'tenant_fhir_config',
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_fhir_config() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_fhir_config" AFTER INSERT OR UPDATE OR DELETE ON tenant_fhir_config
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_fhir_config();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_fhir_client_credential() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['secret_cipher','secret_digest_sha256']::text[];
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
    'fhir_client_credential.' || lower(TG_OP),
    'fhir_client_credential',
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
ALTER FUNCTION audit_phi_write_fhir_client_credential() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_fhir_client_credential" AFTER INSERT OR UPDATE OR DELETE ON fhir_client_credential
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_fhir_client_credential();--> statement-breakpoint
-- Empty denylist, but PARTITIONED, so the parent name is hard-coded; retention 'operational' (§3.7).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_fhir_client_session() RETURNS trigger
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
    'fhir_client_session.' || lower(TG_OP),
    'fhir_client_session',
    COALESCE(NEW.jti, OLD.jti),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_fhir_client_session() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_fhir_client_session" AFTER INSERT OR UPDATE OR DELETE ON fhir_client_session
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_fhir_client_session();--> statement-breakpoint
-- Denylist `payload` + PARTITIONED, so the parent name is hard-coded.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_fhir_inbound_resource() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload']::text[];
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
    'fhir_inbound_resource.' || lower(TG_OP),
    'fhir_inbound_resource',
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
ALTER FUNCTION audit_phi_write_fhir_inbound_resource() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_fhir_inbound_resource" AFTER INSERT OR UPDATE OR DELETE ON fhir_inbound_resource
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_fhir_inbound_resource();
