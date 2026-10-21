-- M31 Patient/Family Portal & Telehealth §3.5/§3.6 — RLS + grants on the three owned tables and the M4
-- write-audit trigger (generateAuditTrigger shape) on each. Tables + enums land in 0138.
--
-- 1. RLS (§3.5 / ADR-0010 D2): row visibility keys ONLY on app.org_id, set by withOrgContext(). The two
--    patient-bearing tables carry provider_entity_id + location_id (0138) for the §4.3 rollups, but the RLS
--    pivot stays organization_id ALONE — a second permissive policy would OR, not AND. The layered checks
--    §3.5 names (the `portal_grant_active_for_patient` / `telehealth_consent_active` per-record filters, the
--    staff-side `portal_account_in_caseload` debug scope) are M3 ABAC at the route, never RLS: RLS is the
--    tenant moat, ABAC is the per-record filter. FORCE ROW LEVEL SECURITY closes the owner-bypass hole
--    (mig 0118's HOLE 1) so these tables stay isolated even if wardenx_app ever becomes their owner.
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on NOTHING — M31 rows are append plus
--    status-transition (invite→activate→suspend→revoke, grant→revoke, room lifecycle), and destruction goes
--    through the admin-run eraseFn (§3.7, which lands with a later task). wardenx_admin keeps ALL.
--
-- 2. M4 write-audit triggers (§3.6). RETENTION CLASS: audit_event.retention_class is M1's
--    audit_retention_class enum; these stamp 'compliance' (the 7-year HIPAA-floor class). The per-table
--    denylists mirror `M31_AUDIT_DENYLIST` in @wardenx/types VERBATIM so the DB-side scrub and the code-side
--    export view cannot drift:
--      portal_account       display_name_cipher / email_cipher / phone_cipher   (envelope-encrypted contact PHI)
--      portal_access_grant  scope_set_jsonb (size) / revoke_reason_cipher       (free-text)
--      telehealth_visit     vendor_room_id_cipher / vendor_room_url_cipher / end_reason_detail_cipher
--    The denylisted columns never enter audit_event.before/after; audit_scrub replaces each with a marker so
--    the audit row keeps its change-detection signal without capturing the plaintext/large value.
-- 1. RLS policies + grants (§3.5).--> statement-breakpoint
ALTER TABLE "portal_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_account" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_account_org" ON "portal_account";
CREATE POLICY "portal_account_org" ON "portal_account"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "portal_account" TO wardenx_app;
GRANT ALL ON "portal_account" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "portal_access_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_access_grant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_access_grant_org" ON "portal_access_grant";
CREATE POLICY "portal_access_grant_org" ON "portal_access_grant"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "portal_access_grant" TO wardenx_app;
GRANT ALL ON "portal_access_grant" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "telehealth_visit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telehealth_visit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "telehealth_visit_org" ON "telehealth_visit";
CREATE POLICY "telehealth_visit_org" ON "telehealth_visit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "telehealth_visit" TO wardenx_app;
GRANT ALL ON "telehealth_visit" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table §3.6 denylist).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_portal_account() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['display_name_cipher','email_cipher','phone_cipher']::text[];
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
    'portal_account.' || lower(TG_OP),
    'portal_account',
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
ALTER FUNCTION audit_phi_write_portal_account() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_account" AFTER INSERT OR UPDATE OR DELETE ON portal_account
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_account();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_portal_access_grant() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['scope_set_jsonb','revoke_reason_cipher']::text[];
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
    'portal_access_grant.' || lower(TG_OP),
    'portal_access_grant',
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
ALTER FUNCTION audit_phi_write_portal_access_grant() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_access_grant" AFTER INSERT OR UPDATE OR DELETE ON portal_access_grant
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_access_grant();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_telehealth_visit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['vendor_room_id_cipher','vendor_room_url_cipher','end_reason_detail_cipher']::text[];
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
    'telehealth_visit.' || lower(TG_OP),
    'telehealth_visit',
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
ALTER FUNCTION audit_phi_write_telehealth_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_telehealth_visit" AFTER INSERT OR UPDATE OR DELETE ON telehealth_visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_telehealth_visit();
