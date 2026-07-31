-- M15 Discipline Care Plans §3.6/§3.7 — RLS + grants on all 11 owned tables, and the M4 write-audit
-- trigger (generateAuditTrigger shape) on each. Tables/enums/indexes land in 0098 (M15-T02).
--
-- 1. RLS (ADR-0010 D2 / §3.7): row visibility keys ONLY on app.org_id, set by withOrgContext(). The eight
--    patient-bearing tables carry provider_entity_id + location_id for ABAC narrowing (M15-F05), but the
--    RLS pivot stays organization_id alone — a second permissive policy would OR, not AND. The §7.8/§7.9
--    SUD and family-violence content classes are filtered in the repository WHERE clause driven by the M3
--    ABAC predicates (M15-T06); RLS is never relied on for content-class confidentiality (§3.7).
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on NONE — plans, versions, signatures,
--    assessments and hour entries are append + status-transition; destruction clears through the admin-run
--    eraseFn (§8.5). wardenx_admin keeps ALL (migration/eraser role).
--
-- 2. M4 write-audit triggers (§3.6, retention class 'compliance' — CoP 418.56/418.76/418.78 records, M4 D1).
--    Denylists mirror @wardenx/types M15_AUDIT_DENYLIST verbatim, so the code-side eraser/export view and
--    the DB-side scrub cannot drift:
--      discipline_care_plan            spiritual_care_declined
--      discipline_care_plan_version    (nested) state_snapshot → goals / interventions / data
--      discipline_care_plan_signature  attestation_text
--      discipline_goal                 original_text / revised_text / measurable_outcome / modality_text
--      discipline_intervention         scope_text / discontinuation_reason
--      discipline_assessment           amendment_reason + (nested) data → notes / narrativeRef /
--                                      safetyConsiderations / focuses / concerns / bereavementRiskFactors
--      aide_supervisory_visit          corrective_actions / supervisory_narrative
--      volunteer_assignment            inactivation_reason
--      volunteer_compliance_gate       notes / revoked_reason
--      volunteer_hour_ledger           (structural only — empty denylist)
--      volunteer_hour_entry            adjustment_reason
--    The two nested cases scrub the top-level columns first, then re-scrub the jsonb object's denylisted
--    keys — the M14 idg_decision precedent. All 11 tables carry organization_id, so all 11 get BOTH a
--    policy and a trigger (the arch:gaps phi-guards floor).--> statement-breakpoint
-- 1. RLS policies + grants (§3.7).--> statement-breakpoint
ALTER TABLE "discipline_care_plan" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_care_plan_org" ON "discipline_care_plan";
CREATE POLICY "discipline_care_plan_org" ON "discipline_care_plan"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_care_plan" TO wardenx_app;
GRANT ALL ON "discipline_care_plan" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discipline_care_plan_version" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_care_plan_version_org" ON "discipline_care_plan_version";
CREATE POLICY "discipline_care_plan_version_org" ON "discipline_care_plan_version"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_care_plan_version" TO wardenx_app;
GRANT ALL ON "discipline_care_plan_version" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discipline_care_plan_signature" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_care_plan_signature_org" ON "discipline_care_plan_signature";
CREATE POLICY "discipline_care_plan_signature_org" ON "discipline_care_plan_signature"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_care_plan_signature" TO wardenx_app;
GRANT ALL ON "discipline_care_plan_signature" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discipline_goal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_goal_org" ON "discipline_goal";
CREATE POLICY "discipline_goal_org" ON "discipline_goal"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_goal" TO wardenx_app;
GRANT ALL ON "discipline_goal" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discipline_intervention" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_intervention_org" ON "discipline_intervention";
CREATE POLICY "discipline_intervention_org" ON "discipline_intervention"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_intervention" TO wardenx_app;
GRANT ALL ON "discipline_intervention" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "discipline_assessment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "discipline_assessment_org" ON "discipline_assessment";
CREATE POLICY "discipline_assessment_org" ON "discipline_assessment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "discipline_assessment" TO wardenx_app;
GRANT ALL ON "discipline_assessment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "aide_supervisory_visit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "aide_supervisory_visit_org" ON "aide_supervisory_visit";
CREATE POLICY "aide_supervisory_visit_org" ON "aide_supervisory_visit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "aide_supervisory_visit" TO wardenx_app;
GRANT ALL ON "aide_supervisory_visit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "volunteer_assignment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "volunteer_assignment_org" ON "volunteer_assignment";
CREATE POLICY "volunteer_assignment_org" ON "volunteer_assignment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "volunteer_assignment" TO wardenx_app;
GRANT ALL ON "volunteer_assignment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "volunteer_compliance_gate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "volunteer_compliance_gate_org" ON "volunteer_compliance_gate";
CREATE POLICY "volunteer_compliance_gate_org" ON "volunteer_compliance_gate"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "volunteer_compliance_gate" TO wardenx_app;
GRANT ALL ON "volunteer_compliance_gate" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "volunteer_hour_ledger" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "volunteer_hour_ledger_org" ON "volunteer_hour_ledger";
CREATE POLICY "volunteer_hour_ledger_org" ON "volunteer_hour_ledger"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "volunteer_hour_ledger" TO wardenx_app;
GRANT ALL ON "volunteer_hour_ledger" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "volunteer_hour_entry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "volunteer_hour_entry_org" ON "volunteer_hour_entry";
CREATE POLICY "volunteer_hour_entry_org" ON "volunteer_hour_entry"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "volunteer_hour_entry" TO wardenx_app;
GRANT ALL ON "volunteer_hour_entry" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table PHI denylist, §3.6). audit_scrub keys on top-level columns;
--    discipline_care_plan_version additionally re-scrubs the sealed `state_snapshot` branches and
--    discipline_assessment the per-kind `data` payload's free-text keys — a top-level denylist misses both.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_care_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['spiritual_care_declined']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['spiritual_care_declined']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discipline_care_plan.' || lower(TG_OP),
    'discipline_care_plan',
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
ALTER FUNCTION audit_phi_write_discipline_care_plan() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_care_plan" AFTER INSERT OR UPDATE OR DELETE ON discipline_care_plan
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_care_plan();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_care_plan_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_nested_keys text[] := ARRAY['goals','interventions','data']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY[]::text[]);
    IF v_before ? 'state_snapshot' AND jsonb_typeof(v_before->'state_snapshot') = 'object' THEN
      v_before := jsonb_set(v_before, '{state_snapshot}', audit_scrub(v_before->'state_snapshot', v_nested_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), ARRAY[]::text[]);
    IF v_after ? 'state_snapshot' AND jsonb_typeof(v_after->'state_snapshot') = 'object' THEN
      v_after := jsonb_set(v_after, '{state_snapshot}', audit_scrub(v_after->'state_snapshot', v_nested_keys));
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
    'discipline_care_plan_version.' || lower(TG_OP),
    'discipline_care_plan_version',
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
ALTER FUNCTION audit_phi_write_discipline_care_plan_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_care_plan_version" AFTER INSERT OR UPDATE OR DELETE ON discipline_care_plan_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_care_plan_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_care_plan_signature() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['attestation_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['attestation_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discipline_care_plan_signature.' || lower(TG_OP),
    'discipline_care_plan_signature',
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
ALTER FUNCTION audit_phi_write_discipline_care_plan_signature() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_care_plan_signature" AFTER INSERT OR UPDATE OR DELETE ON discipline_care_plan_signature
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_care_plan_signature();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_goal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['original_text','revised_text','measurable_outcome','modality_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['original_text','revised_text','measurable_outcome','modality_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discipline_goal.' || lower(TG_OP),
    'discipline_goal',
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
ALTER FUNCTION audit_phi_write_discipline_goal() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_goal" AFTER INSERT OR UPDATE OR DELETE ON discipline_goal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_goal();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_intervention() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['scope_text','discontinuation_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['scope_text','discontinuation_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discipline_intervention.' || lower(TG_OP),
    'discipline_intervention',
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
ALTER FUNCTION audit_phi_write_discipline_intervention() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_intervention" AFTER INSERT OR UPDATE OR DELETE ON discipline_intervention
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_intervention();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_discipline_assessment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_nested_keys text[] := ARRAY['notes','narrativeRef','safetyConsiderations','focuses','concerns','bereavementRiskFactors']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY['amendment_reason']::text[]);
    IF v_before ? 'data' AND jsonb_typeof(v_before->'data') = 'object' THEN
      v_before := jsonb_set(v_before, '{data}', audit_scrub(v_before->'data', v_nested_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), ARRAY['amendment_reason']::text[]);
    IF v_after ? 'data' AND jsonb_typeof(v_after->'data') = 'object' THEN
      v_after := jsonb_set(v_after, '{data}', audit_scrub(v_after->'data', v_nested_keys));
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
    'discipline_assessment.' || lower(TG_OP),
    'discipline_assessment',
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
ALTER FUNCTION audit_phi_write_discipline_assessment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_discipline_assessment" AFTER INSERT OR UPDATE OR DELETE ON discipline_assessment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_discipline_assessment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_aide_supervisory_visit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['corrective_actions','supervisory_narrative']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['corrective_actions','supervisory_narrative']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'aide_supervisory_visit.' || lower(TG_OP),
    'aide_supervisory_visit',
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
ALTER FUNCTION audit_phi_write_aide_supervisory_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_aide_supervisory_visit" AFTER INSERT OR UPDATE OR DELETE ON aide_supervisory_visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_aide_supervisory_visit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_volunteer_assignment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['inactivation_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['inactivation_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'volunteer_assignment.' || lower(TG_OP),
    'volunteer_assignment',
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
ALTER FUNCTION audit_phi_write_volunteer_assignment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_volunteer_assignment" AFTER INSERT OR UPDATE OR DELETE ON volunteer_assignment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_volunteer_assignment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_volunteer_compliance_gate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['notes','revoked_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['notes','revoked_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'volunteer_compliance_gate.' || lower(TG_OP),
    'volunteer_compliance_gate',
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
ALTER FUNCTION audit_phi_write_volunteer_compliance_gate() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_volunteer_compliance_gate" AFTER INSERT OR UPDATE OR DELETE ON volunteer_compliance_gate
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_volunteer_compliance_gate();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_volunteer_hour_ledger() RETURNS trigger
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
    'volunteer_hour_ledger.' || lower(TG_OP),
    'volunteer_hour_ledger',
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
ALTER FUNCTION audit_phi_write_volunteer_hour_ledger() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_volunteer_hour_ledger" AFTER INSERT OR UPDATE OR DELETE ON volunteer_hour_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_volunteer_hour_ledger();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_volunteer_hour_entry() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['adjustment_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['adjustment_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'volunteer_hour_entry.' || lower(TG_OP),
    'volunteer_hour_entry',
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
ALTER FUNCTION audit_phi_write_volunteer_hour_entry() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_volunteer_hour_entry" AFTER INSERT OR UPDATE OR DELETE ON volunteer_hour_entry
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_volunteer_hour_entry();
