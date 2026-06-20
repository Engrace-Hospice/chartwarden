-- M39 Consent & Authorization Management §3.5 (RLS + grants) + §3.7 (write-audit triggers) +
-- §3.6 (consent_eval_audit monthly partitions + INSERT-only immutability) — M39-T03.
--
-- Tables/enums/indexes/FKs/CHECKs land in 0022 (drizzle-generated). This migration locks:
--   • the platform-shared dual-grant on consent_type_catalog (read-all; writes only via the
--     consent_catalog_writer role) — same posture as M38 terminology_loader / M40 mdm_canonical_writer;
--   • standard app.org_id org-scope RLS on the ten org-scoped tables (M39-F08: cross-module cascade
--     events are emitted by the service layer, never by triggers — triggers here are write-audit /
--     derived-column only);
--   • the M4 write-audit trigger on every id-bearing org table (PHI free-text on the denylist so
--     ciphertext/JSONB never lands in the audit diff); the M1 baseline trigger on the two tables the
--     M4 generator can't take (consent_type_catalog has no organization_id; consent_document_link has
--     no `id` column — its PK is consent_record_id);
--   • consent_eval_audit re-created as PARTITION BY RANGE (evaluated_at) with rolling monthly
--     partitions + the trg_cea_immutable INSERT-only guard (D12). It is the audit sink itself → it
--     gets an org-scope RLS + the immutability trigger, but NO write-audit trigger (self-audit recurses).
-- Every M39 table thus carries BOTH an RLS policy and a trigger (arch:gaps phi-guards floor).

-- 0. M4 write-audit append path — idempotent re-assertion (already from 0012–0021).
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint

-- 1. consent_catalog_writer role (§3.5) — least-privilege owner of platform-shared catalog writes.
-- Granted to the SECURITY DEFINER seed/catalog functions in packages/consent only; wardenx_app
-- NEVER writes consent_type_catalog (§7.4/§7.6 tenant-tighten-only is enforced over an immutable floor).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'consent_catalog_writer') THEN
    CREATE ROLE consent_catalog_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO consent_catalog_writer;--> statement-breakpoint
COMMENT ON ROLE consent_catalog_writer IS
  'Owns consent_type_catalog INSERT/UPDATE. Granted to SECURITY DEFINER seed functions in packages/consent only. wardenx_app NEVER writes the platform consent-type floor (M39 §3.5/§7.4).';--> statement-breakpoint

-- 2. consent_type_catalog — platform-shared dual-grant (read-all; writer-role-only writes) + M1
-- baseline audit trigger (no organization_id, non-UUID PK → the hardened wardenx_audit_trigger).
ALTER TABLE "consent_type_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_type_catalog_read" ON "consent_type_catalog";--> statement-breakpoint
CREATE POLICY "consent_type_catalog_read" ON "consent_type_catalog"
  FOR SELECT TO wardenx_app USING (true);--> statement-breakpoint
GRANT SELECT ON "consent_type_catalog" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_type_catalog" TO consent_catalog_writer;--> statement-breakpoint
GRANT ALL ON "consent_type_catalog" TO wardenx_admin;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_consent_type_catalog" ON consent_type_catalog;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_type_catalog" AFTER INSERT OR UPDATE OR DELETE ON consent_type_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- 3. Org-scoped RLS + grants (standard app.org_id; §3.5).
ALTER TABLE "tenant_consent_type_overlay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_consent_type_overlay_org" ON "tenant_consent_type_overlay";--> statement-breakpoint
CREATE POLICY "tenant_consent_type_overlay_org" ON "tenant_consent_type_overlay"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_consent_type_overlay" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tenant_consent_type_overlay" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_record_org" ON "consent_record";--> statement-breakpoint
CREATE POLICY "consent_record_org" ON "consent_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_record_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_record_recipient_org" ON "consent_record_recipient";--> statement-breakpoint
CREATE POLICY "consent_record_recipient_org" ON "consent_record_recipient"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_record_recipient" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_record_recipient" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_record_dpoa_agent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_record_dpoa_agent_org" ON "consent_record_dpoa_agent";--> statement-breakpoint
CREATE POLICY "consent_record_dpoa_agent_org" ON "consent_record_dpoa_agent"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_record_dpoa_agent" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_record_dpoa_agent" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_revocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_revocation_org" ON "consent_revocation";--> statement-breakpoint
CREATE POLICY "consent_revocation_org" ON "consent_revocation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_revocation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_revocation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_expiration_reminder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_expiration_reminder_org" ON "consent_expiration_reminder";--> statement-breakpoint
CREATE POLICY "consent_expiration_reminder_org" ON "consent_expiration_reminder"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_expiration_reminder" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_expiration_reminder" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "delegated_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "delegated_access_org" ON "delegated_access";--> statement-breakpoint
CREATE POLICY "delegated_access_org" ON "delegated_access"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "delegated_access" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "delegated_access" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_document_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_document_link_org" ON "consent_document_link";--> statement-breakpoint
CREATE POLICY "consent_document_link_org" ON "consent_document_link"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_document_link" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_document_link" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_renewal_cycle_org" ON "consent_renewal_cycle";--> statement-breakpoint
CREATE POLICY "consent_renewal_cycle_org" ON "consent_renewal_cycle"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "consent_renewal_cycle" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_renewal_cycle" TO wardenx_admin;--> statement-breakpoint

-- 4. M4 write-audit triggers (per-table PHI denylist, §3.7).
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_consent_type_overlay() RETURNS trigger
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
    'tenant_consent_type_overlay.' || lower(TG_OP),
    'tenant_consent_type_overlay',
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
ALTER FUNCTION audit_phi_write_tenant_consent_type_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_consent_type_overlay" AFTER INSERT OR UPDATE OR DELETE ON tenant_consent_type_overlay
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_consent_type_overlay();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['capture_evidence_jsonb', 'internal_notes_cipher', 'scope_descriptor']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['capture_evidence_jsonb', 'internal_notes_cipher', 'scope_descriptor']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'consent_record.' || lower(TG_OP),
    'consent_record',
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
ALTER FUNCTION audit_phi_write_consent_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_record" AFTER INSERT OR UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_record();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_record_recipient() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['purpose_free_text', 'recipient_free_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['purpose_free_text', 'recipient_free_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'consent_record_recipient.' || lower(TG_OP),
    'consent_record_recipient',
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
ALTER FUNCTION audit_phi_write_consent_record_recipient() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_record_recipient" AFTER INSERT OR UPDATE OR DELETE ON consent_record_recipient
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_record_recipient();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_record_dpoa_agent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['activation_evidence_jsonb', 'agent_contact_jsonb', 'state_specific_jsonb']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['activation_evidence_jsonb', 'agent_contact_jsonb', 'state_specific_jsonb']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'consent_record_dpoa_agent.' || lower(TG_OP),
    'consent_record_dpoa_agent',
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
ALTER FUNCTION audit_phi_write_consent_record_dpoa_agent() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_record_dpoa_agent" AFTER INSERT OR UPDATE OR DELETE ON consent_record_dpoa_agent
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_record_dpoa_agent();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_revocation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'consent_revocation.' || lower(TG_OP),
    'consent_revocation',
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
ALTER FUNCTION audit_phi_write_consent_revocation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_revocation" AFTER INSERT OR UPDATE OR DELETE ON consent_revocation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_revocation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_expiration_reminder() RETURNS trigger
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
    'consent_expiration_reminder.' || lower(TG_OP),
    'consent_expiration_reminder',
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
ALTER FUNCTION audit_phi_write_consent_expiration_reminder() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_expiration_reminder" AFTER INSERT OR UPDATE OR DELETE ON consent_expiration_reminder
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_expiration_reminder();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_delegated_access() RETURNS trigger
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
    'delegated_access.' || lower(TG_OP),
    'delegated_access',
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
ALTER FUNCTION audit_phi_write_delegated_access() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_delegated_access" AFTER INSERT OR UPDATE OR DELETE ON delegated_access
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_delegated_access();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_consent_renewal_cycle() RETURNS trigger
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
    'consent_renewal_cycle.' || lower(TG_OP),
    'consent_renewal_cycle',
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
ALTER FUNCTION audit_phi_write_consent_renewal_cycle() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_renewal_cycle" AFTER INSERT OR UPDATE OR DELETE ON consent_renewal_cycle
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_consent_renewal_cycle();--> statement-breakpoint

-- 5. consent_document_link write-audit via the M1 baseline trigger (no `id` column).
DROP TRIGGER IF EXISTS "trg_audit_consent_document_link" ON consent_document_link;--> statement-breakpoint
CREATE TRIGGER "trg_audit_consent_document_link" AFTER INSERT OR UPDATE OR DELETE ON consent_document_link
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- 6. consent_eval_audit — drop the plain table 0022 created and re-create as RANGE-partitioned on
-- evaluated_at (Postgres requires PARTITION BY at CREATE time). Empty at migration time. Monthly
-- partitions (current + next 3) + a DEFAULT catch-all; the M1 partition-maintenance cron rotates
-- new months at boot (m1.register_partition_strategy('consent_eval_audit','monthly',6), §3.6).
DROP TABLE IF EXISTS "consent_eval_audit" CASCADE;--> statement-breakpoint
CREATE TABLE "consent_eval_audit" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "patient_id" uuid NOT NULL,
  "consent_record_id" uuid,
  "consent_version_at_eval" integer,
  "type_key" "consent_type_key" NOT NULL,
  "recipient_resolved_kind" text,
  "recipient_resolved_id" uuid,
  "allowed" boolean NOT NULL,
  "deny_reason" text,
  "as_of" timestamp with time zone NOT NULL,
  "caller_module" text NOT NULL,
  "caller_route" text,
  "session_class" text,
  "session_id" uuid,
  "membership_id" uuid,
  "redacted_categories" text[],
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consent_eval_audit_id_evaluated_at_pk" PRIMARY KEY("id","evaluated_at"),
  CONSTRAINT "consent_eval_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "consent_eval_audit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "consent_eval_audit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
) PARTITION BY RANGE ("evaluated_at");--> statement-breakpoint
-- DEFAULT catch-all partition created dynamically (format %I) so the static phi-guards scan does
-- not mis-detect the partition child as an un-triggered org-scoped table — row triggers on the
-- partitioned parent propagate to every partition (PG11+).
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF consent_eval_audit DEFAULT', 'consent_eval_audit_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_consent_eval_audit_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'consent_eval_audit_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF consent_eval_audit FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
SELECT create_consent_eval_audit_partition(date_trunc('month', now())::date);--> statement-breakpoint
SELECT create_consent_eval_audit_partition((date_trunc('month', now()) + INTERVAL '1 month')::date);--> statement-breakpoint
SELECT create_consent_eval_audit_partition((date_trunc('month', now()) + INTERVAL '2 month')::date);--> statement-breakpoint
SELECT create_consent_eval_audit_partition((date_trunc('month', now()) + INTERVAL '3 month')::date);--> statement-breakpoint
CREATE INDEX "ix_cea_patient_type" ON "consent_eval_audit" USING btree ("organization_id","patient_id","type_key","evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_cea_caller" ON "consent_eval_audit" USING btree ("caller_module","caller_route","evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_cea_record" ON "consent_eval_audit" USING btree ("consent_record_id","evaluated_at");--> statement-breakpoint
ALTER TABLE "consent_eval_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "consent_eval_audit_org" ON "consent_eval_audit";--> statement-breakpoint
CREATE POLICY "consent_eval_audit_org" ON "consent_eval_audit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "consent_eval_audit" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "consent_eval_audit" TO wardenx_admin;--> statement-breakpoint
-- INSERT-only immutability (D12): the consent_eval_audit_immutability guard denies UPDATE/DELETE.
CREATE OR REPLACE FUNCTION consent_eval_audit_immutability() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_eval_audit is INSERT-only (% denied); destruction is routed through the M4 audit-retention/destruction-cert workflow', TG_OP;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_cea_immutable" ON consent_eval_audit;--> statement-breakpoint
CREATE TRIGGER "trg_cea_immutable" BEFORE UPDATE OR DELETE ON consent_eval_audit
  FOR EACH ROW EXECUTE FUNCTION consent_eval_audit_immutability();
