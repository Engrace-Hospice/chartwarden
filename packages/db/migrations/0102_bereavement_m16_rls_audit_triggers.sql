-- M16 Bereavement §3.5/§3.7 — RLS + grants on all 9 owned tables, the M4 write-audit trigger
-- (generateAuditTrigger shape) on each, and the D11 risk-score immutability trigger. Tables/enums land in
-- 0100 (unpartitioned) and 0101 (the partitioned contact log).
--
-- 1. RLS (§3.5 / ADR-0010 D2): row visibility keys ONLY on app.org_id, set by withOrgContext(). The eight
--    patient-bearing tables carry provider_entity_id + location_id for the §4.6 compliance rollups, but the
--    RLS pivot stays organization_id ALONE — a second permissive policy would OR, not AND. The layered
--    checks §3.5 names (counselor caseload, the D10 volunteer reduced-PHI scope, the M31 bereaved-contact
--    portal scope) are M3 ABAC at the route, never RLS: RLS is the tenant moat, ABAC is the per-record filter.
--
--    For `bereavement_contact_log` the policy + grants are declared on the PARTITIONED PARENT only; they
--    propagate to every partition (PG11+, the M25/M30 precedent).
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on NOTHING — M16 rows are append plus
--    status-transition, and destruction goes through the admin-run eraseFn (§8.5). `bereavement_risk_score`
--    gets SELECT/INSERT only: the D11 immutability trigger below refuses UPDATE anyway, and withholding the
--    privilege makes that a permission error rather than a runtime exception. wardenx_admin keeps ALL.
--
-- 2. M4 write-audit triggers (§3.7). RETENTION CLASS NOTE: `audit_event.retention_class` is M1's
--    `audit_retention_class` enum (operational | compliance | legal_hold | compliance_42cfr_part2), so these
--    triggers stamp 'compliance' — the 7-year HIPAA-floor class. That is NOT in tension with §3.4.1's
--    `clinical_record` assignment: `clinical_record` is the M4 RETENTION/eraser data class for the M16 ROWS
--    (CoP 418.64(d)/418.104 records of care, ADR-0004), registered through M4's retention API at boot and
--    carried by the eraser's `dataClass`, which lands with the routes task. Two different axes; both apply.
--
--    Denylists mirror `M16_AUDIT_DENYLIST` in @chartwarden/types VERBATIM, so the code-side eraser/export view
--    and the DB-side scrub cannot drift:
--      bereavement_plan            pause_reason_redacted / ipoc_bereavement_intent_summary_redacted
--      bereaved_contact            ineligible_reason_redacted
--      bereavement_risk_score      augmented_narrative_redacted + (nested) risk_factors_jsonb →
--                                  notes_cipher / narrative
--      bereavement_outreach        cancellation_reason_redacted
--      bereavement_contact_log     contact_notes_cipher
--      bereavement_anniversary_reminder  (structural only — empty denylist)
--      bereavement_plan_closure    reason_narrative_redacted
--      bereavement_opt_out         reason_redacted
--      tenant_bereavement_external_source_gate_override  additional_rationale
--
--    The `*_cipher` CONTACT-CHANNEL columns on bereaved_contact (email/phone/mailing address) are
--    deliberately ABSENT from the denylist: they are already envelope-encrypted ciphertext, and scrubbing
--    them would throw away the only change-detection signal an audit row has for a channel edit. The one
--    cipher column that IS denylisted (`contact_notes_cipher`, and the nested `notes_cipher` inside the risk
--    factors) is denylisted because it is the free-text clinical note itself, per D11.
--
--    `bereavement_risk_score` re-scrubs the nested `risk_factors_jsonb` object after the top-level pass —
--    a top-level denylist would miss `notes_cipher`/`narrative` sitting inside it (the M14 idg_decision /
--    M15 discipline_assessment precedent).
--
-- 3. D11 immutability: `bereavement_risk_score` refuses UPDATE outright. A "correction" is a NEW append-only
--    row (D8), so the audit trail can never lose the tier a cadence decision was actually made on.
-- 1. RLS policies + grants (§3.5).--> statement-breakpoint
ALTER TABLE "bereavement_plan" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_plan_org" ON "bereavement_plan";
CREATE POLICY "bereavement_plan_org" ON "bereavement_plan"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_plan" TO wardenx_app;
GRANT ALL ON "bereavement_plan" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereaved_contact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereaved_contact_org" ON "bereaved_contact";
CREATE POLICY "bereaved_contact_org" ON "bereaved_contact"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereaved_contact" TO wardenx_app;
GRANT ALL ON "bereaved_contact" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_risk_score" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_risk_score_org" ON "bereavement_risk_score";
CREATE POLICY "bereavement_risk_score_org" ON "bereavement_risk_score"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "bereavement_risk_score" TO wardenx_app;
GRANT ALL ON "bereavement_risk_score" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_outreach" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_outreach_org" ON "bereavement_outreach";
CREATE POLICY "bereavement_outreach_org" ON "bereavement_outreach"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_outreach" TO wardenx_app;
GRANT ALL ON "bereavement_outreach" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_contact_log_org" ON "bereavement_contact_log";
CREATE POLICY "bereavement_contact_log_org" ON "bereavement_contact_log"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_contact_log" TO wardenx_app;
GRANT ALL ON "bereavement_contact_log" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_anniversary_reminder" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_anniversary_reminder_org" ON "bereavement_anniversary_reminder";
CREATE POLICY "bereavement_anniversary_reminder_org" ON "bereavement_anniversary_reminder"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_anniversary_reminder" TO wardenx_app;
GRANT ALL ON "bereavement_anniversary_reminder" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_plan_closure" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_plan_closure_org" ON "bereavement_plan_closure";
CREATE POLICY "bereavement_plan_closure_org" ON "bereavement_plan_closure"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_plan_closure" TO wardenx_app;
GRANT ALL ON "bereavement_plan_closure" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "bereavement_opt_out" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bereavement_opt_out_org" ON "bereavement_opt_out";
CREATE POLICY "bereavement_opt_out_org" ON "bereavement_opt_out"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "bereavement_opt_out" TO wardenx_app;
GRANT ALL ON "bereavement_opt_out" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tenant_bereavement_external_source_gate_override" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_bereavement_external_source_gate_override_org" ON "tenant_bereavement_external_source_gate_override";
CREATE POLICY "tenant_bereavement_external_source_gate_override_org" ON "tenant_bereavement_external_source_gate_override"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "tenant_bereavement_external_source_gate_override" TO wardenx_app;
GRANT ALL ON "tenant_bereavement_external_source_gate_override" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table D11 denylist, §3.7).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['pause_reason_redacted','ipoc_bereavement_intent_summary_redacted']::text[];
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
    'bereavement_plan.' || lower(TG_OP),
    'bereavement_plan',
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
ALTER FUNCTION audit_phi_write_bereavement_plan() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_plan" AFTER INSERT OR UPDATE OR DELETE ON bereavement_plan
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_plan();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereaved_contact() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['ineligible_reason_redacted']::text[];
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
    'bereaved_contact.' || lower(TG_OP),
    'bereaved_contact',
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
ALTER FUNCTION audit_phi_write_bereaved_contact() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereaved_contact" AFTER INSERT OR UPDATE OR DELETE ON bereaved_contact
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereaved_contact();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_risk_score() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['augmented_narrative_redacted']::text[];
  v_nested_keys text[] := ARRAY['notes_cipher','narrative']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), v_cols);
    IF v_before ? 'risk_factors_jsonb' AND jsonb_typeof(v_before->'risk_factors_jsonb') = 'object' THEN
      v_before := jsonb_set(v_before, '{risk_factors_jsonb}', audit_scrub(v_before->'risk_factors_jsonb', v_nested_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), v_cols);
    IF v_after ? 'risk_factors_jsonb' AND jsonb_typeof(v_after->'risk_factors_jsonb') = 'object' THEN
      v_after := jsonb_set(v_after, '{risk_factors_jsonb}', audit_scrub(v_after->'risk_factors_jsonb', v_nested_keys));
    END IF;
  END IF;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'bereavement_risk_score.' || lower(TG_OP),
    'bereavement_risk_score',
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
ALTER FUNCTION audit_phi_write_bereavement_risk_score() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_risk_score" AFTER INSERT OR UPDATE OR DELETE ON bereavement_risk_score
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_risk_score();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_outreach() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['cancellation_reason_redacted']::text[];
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
    'bereavement_outreach.' || lower(TG_OP),
    'bereavement_outreach',
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
ALTER FUNCTION audit_phi_write_bereavement_outreach() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_outreach" AFTER INSERT OR UPDATE OR DELETE ON bereavement_outreach
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_outreach();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_contact_log() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['contact_notes_cipher']::text[];
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
    'bereavement_contact_log.' || lower(TG_OP),
    'bereavement_contact_log',
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
ALTER FUNCTION audit_phi_write_bereavement_contact_log() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_contact_log" AFTER INSERT OR UPDATE OR DELETE ON bereavement_contact_log
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_contact_log();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_anniversary_reminder() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
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
    'bereavement_anniversary_reminder.' || lower(TG_OP),
    'bereavement_anniversary_reminder',
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
ALTER FUNCTION audit_phi_write_bereavement_anniversary_reminder() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_anniversary_reminder" AFTER INSERT OR UPDATE OR DELETE ON bereavement_anniversary_reminder
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_anniversary_reminder();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_plan_closure() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reason_narrative_redacted']::text[];
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
    'bereavement_plan_closure.' || lower(TG_OP),
    'bereavement_plan_closure',
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
ALTER FUNCTION audit_phi_write_bereavement_plan_closure() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_plan_closure" AFTER INSERT OR UPDATE OR DELETE ON bereavement_plan_closure
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_plan_closure();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_opt_out() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reason_redacted']::text[];
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
    'bereavement_opt_out.' || lower(TG_OP),
    'bereavement_opt_out',
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
ALTER FUNCTION audit_phi_write_bereavement_opt_out() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_opt_out" AFTER INSERT OR UPDATE OR DELETE ON bereavement_opt_out
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_opt_out();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_berv_gate_override() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['additional_rationale']::text[];
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
    'tenant_bereavement_external_source_gate_override.' || lower(TG_OP),
    'tenant_bereavement_external_source_gate_override',
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
ALTER FUNCTION audit_phi_write_tenant_berv_gate_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_berv_gate_override" AFTER INSERT OR UPDATE OR DELETE ON tenant_bereavement_external_source_gate_override
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_berv_gate_override();--> statement-breakpoint
-- 3. D11 immutability — a risk score is never edited, only superseded by a new append (D8).--> statement-breakpoint
CREATE OR REPLACE FUNCTION m16_bereavement_risk_score_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M16_RISK_SCORE_IMMUTABLE: bereavement_risk_score % is append-only; record a new score row instead of updating', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_bereavement_risk_score_immutable" BEFORE UPDATE ON bereavement_risk_score
  FOR EACH ROW EXECUTE FUNCTION m16_bereavement_risk_score_immutable();
