-- M40 Master Data Management §3.6 (the locked two-table canonical/overlay RLS pattern + grants)
-- + §3.7 (write-audit triggers via the M4 generator) — M40-T03.
--
-- Tables, enums, indexes, FKs and CHECKs land in 0018 (drizzle-generated). This migration locks
-- the per-table RLS, the `mdm_canonical_writer` least-privilege writer role, the supporting grants,
-- and the per-table write-audit triggers. M40 owns 11 tables (manifest-authoritative).
--
-- THE THREE RLS SHAPES (§3.6):
--   • CANONICAL (external_physician, facility, payer) + canonical-shape cross-cutting
--     (entity_relationship): org-LESS platform master data — public read to every tenant
--     (USING (true)), writable ONLY via mdm_canonical_writer (the SECURITY DEFINER NPPES/merge/
--     promote functions in packages/mdm own that grant; wardenx_app NEVER writes canonical, §7.4).
--   • OVERLAY + tenant-staged (external_physician_tenant_overlay, mdm_provisional, mdm_baa_record,
--     mdm_baa_required): org-SCOPED — standard app.org_id RLS, the tenant's own rows only.
--   • PLATFORM-OPS (merge_request, nppes_sync_log, nppes_sync_coordination): visible to
--     wardenx_admin only (the platform-ops surface reached via M3 break-glass) — no wardenx_app grant.
--
-- AUDIT TRIGGER STRATEGY (§3.7, reconciled with the M4 generator's contract — the M36/M38 precedent):
--   • The four org-scoped tables carry organization_id, so they get the canonical M4
--     `generateAuditTrigger()` output (audit_phi_write_*, wardenx_audit_writer SECURITY DEFINER,
--     audit_scrub). MDM data is non-PHI directory data, so denylists are minimal: the overlay scrubs
--     only `contract_terms` (commercial terms → change-marker), the rest carry full before/after — the
--     point of §3.7 (every NPPES delta / admin merge / provisional promotion fully auditable).
--   • The seven org-LESS tables can't run the M4 generator (it keys
--     COALESCE(NEW.organization_id, OLD.organization_id), a column they lack), so they take M1's
--     null-safe baseline `wardenx_audit_trigger()` (0004, hardened in 0015 for non-UUID PKs — which
--     also covers nppes_sync_coordination's INTEGER singleton PK → resource_id audits as NULL). Same
--     treatment the M38 platform tables and `permission` (0009) already receive.
-- Every M40 table therefore declares BOTH an RLS policy/enable and an audit trigger (the arch:gaps
-- phi-guards floor; its bleed-tolerant org-scope regex flags the canonical neighbours too, all covered).

-- 1. Canonical writer role (§3.6) — identical posture to M4's wardenx_audit_writer / M38's
-- terminology_loader. Owns canonical INSERT/UPDATE; granted to the SECURITY DEFINER functions in
-- packages/mdm only. wardenx_app NEVER has the capability to write canonical, even buggy code can't.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_canonical_writer') THEN
    CREATE ROLE mdm_canonical_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO mdm_canonical_writer;--> statement-breakpoint
COMMENT ON ROLE mdm_canonical_writer IS
  'Owns canonical-table INSERT/UPDATE. Granted to SECURITY DEFINER functions in packages/mdm only. wardenx_app NEVER writes canonical (M40 §3.6/§7.4).';--> statement-breakpoint

-- 2. Canonical tables — public read, writable only via mdm_canonical_writer (§3.6) ---------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_physician','facility','payer'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_read ON %I FOR SELECT TO wardenx_app USING (true)', t, t);
    EXECUTE format('GRANT SELECT ON %I TO wardenx_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO mdm_canonical_writer', t);
    EXECUTE format('GRANT ALL ON %I TO wardenx_admin', t);
  END LOOP;
END $$;--> statement-breakpoint

-- 3. external_physician_tenant_overlay — standard app.org_id RLS (§3.6) -------------------------
ALTER TABLE "external_physician_tenant_overlay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "external_physician_tenant_overlay_org" ON "external_physician_tenant_overlay"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "external_physician_tenant_overlay" TO wardenx_app;--> statement-breakpoint

-- 4. entity_relationship — canonical-shape (org-less): public read; writes via mdm_canonical_writer.
ALTER TABLE "entity_relationship" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "entity_relationship_read" ON "entity_relationship" FOR SELECT TO wardenx_app USING (true);--> statement-breakpoint
GRANT SELECT ON "entity_relationship" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "entity_relationship" TO mdm_canonical_writer;--> statement-breakpoint
GRANT ALL ON "entity_relationship" TO wardenx_admin;--> statement-breakpoint

-- 5. merge_request — platform-ops surface only (wardenx_admin); no wardenx_app grant (§3.6) ------
ALTER TABLE "merge_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT ALL ON "merge_request" TO wardenx_admin;--> statement-breakpoint

-- 6. nppes_sync_log + nppes_sync_coordination — platform-operational; wardenx_admin only (§3.6) --
ALTER TABLE "nppes_sync_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT ALL ON "nppes_sync_log" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "nppes_sync_coordination" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT ALL ON "nppes_sync_coordination" TO wardenx_admin;--> statement-breakpoint

-- 7. mdm_provisional — org-scoped; tenant proposes (SELECT,INSERT), promotion is wardenx_admin (§3.6)
ALTER TABLE "mdm_provisional" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mdm_provisional_org" ON "mdm_provisional"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "mdm_provisional" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "mdm_provisional" TO wardenx_admin;--> statement-breakpoint

-- 8. mdm_baa_record — org-scoped; the tenant's own BAA register (§3.6, §7.7) --------------------
ALTER TABLE "mdm_baa_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mdm_baa_record_org" ON "mdm_baa_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "mdm_baa_record" TO wardenx_app;--> statement-breakpoint

-- 9. mdm_baa_required — org-scoped per-tenant BAA-gate config (§3.9 Phase D, D8) ----------------
ALTER TABLE "mdm_baa_required" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mdm_baa_required_org" ON "mdm_baa_required"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "mdm_baa_required" TO wardenx_app;--> statement-breakpoint

-- 10. M4 write-audit append path (M04-F06 #2) — idempotent re-assertion (already from 0012–0017) -
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint

-- ============================================================================================
-- §3.7 WRITE-AUDIT TRIGGERS
-- (a) The four organization_id-bearing tables — canonical M4 generateAuditTrigger() output.
--     overlay denylist=['contract_terms']; the others denylist=[]; all retentionClass='compliance'.
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_external_physician_tenant_overlay() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['contract_terms']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['contract_terms']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'physician_overlay.' || lower(TG_OP),
    'physician_overlay',
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
ALTER FUNCTION audit_phi_write_external_physician_tenant_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_external_physician_tenant_overlay" AFTER INSERT OR UPDATE OR DELETE ON external_physician_tenant_overlay
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_external_physician_tenant_overlay();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_mdm_provisional() RETURNS trigger
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
    'mdm_provisional.' || lower(TG_OP),
    'mdm_provisional',
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
ALTER FUNCTION audit_phi_write_mdm_provisional() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mdm_provisional" AFTER INSERT OR UPDATE OR DELETE ON mdm_provisional
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mdm_provisional();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_mdm_baa_record() RETURNS trigger
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
    'mdm_baa_record.' || lower(TG_OP),
    'mdm_baa_record',
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
ALTER FUNCTION audit_phi_write_mdm_baa_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mdm_baa_record" AFTER INSERT OR UPDATE OR DELETE ON mdm_baa_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mdm_baa_record();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_mdm_baa_required() RETURNS trigger
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
    'mdm_baa_required.' || lower(TG_OP),
    'mdm_baa_required',
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
ALTER FUNCTION audit_phi_write_mdm_baa_required() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mdm_baa_required" AFTER INSERT OR UPDATE OR DELETE ON mdm_baa_required
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mdm_baa_required();
--> statement-breakpoint
-- ============================================================================================
-- §3.7 WRITE-AUDIT TRIGGERS
-- (b) The seven org-less tables — M1 null-safe baseline wardenx_audit_trigger() (0004/0015). Same
--     posture as the M38 platform tables / `permission` (0009). nppes_sync_coordination's INTEGER
--     singleton PK is non-UUID, so the 0015 UUID-shape guard audits its resource_id as NULL.
-- ============================================================================================
CREATE TRIGGER "external_physician_audit" AFTER INSERT OR UPDATE OR DELETE ON external_physician
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "facility_audit" AFTER INSERT OR UPDATE OR DELETE ON facility
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "payer_audit" AFTER INSERT OR UPDATE OR DELETE ON payer
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "entity_relationship_audit" AFTER INSERT OR UPDATE OR DELETE ON entity_relationship
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "merge_request_audit" AFTER INSERT OR UPDATE OR DELETE ON merge_request
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "nppes_sync_log_audit" AFTER INSERT OR UPDATE OR DELETE ON nppes_sync_log
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "nppes_sync_coordination_audit" AFTER INSERT OR UPDATE OR DELETE ON nppes_sync_coordination
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
