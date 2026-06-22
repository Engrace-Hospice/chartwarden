-- M7 Care Plan (IPOC) §3.4 (RLS + grants) + §3.5 (write-audit triggers) — M7-T02.
--
-- Tables/enums/indexes/FKs land in 0028 (drizzle-generated). This migration locks:
--   • standard app.org_id org-scope RLS on all six M7 tables (ADR-0010 D2: row visibility keys
--     ONLY on app.org_id, set by withOrgContext());
--   • the §3.6 grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (care-plan
--     rows are never deleted; supersession is via the version status enum superseded/discharged);
--   • the M4 write-audit trigger (generateAuditTrigger) on every table, with the §3.5 PHI denylist
--     so free-text clinical narrative (problem description/resolution, goal original/revised text,
--     intervention scope/frequency, patient-quoted understanding) never lands in the audit diff.
--     All six carry organization_id, so all six get BOTH an RLS policy and a trigger (arch:gaps
--     phi-guards floor). Every M7 table has a UUID PK + organization_id, so each takes the M4
--     generator (no M1 baseline-trigger fallback needed).--> statement-breakpoint
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint
-- 1. Org-scope RLS + grants (standard app.org_id; §3.4). No DELETE — supersession via status.--> statement-breakpoint
ALTER TABLE "care_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "care_plan_org" ON "care_plan";--> statement-breakpoint
CREATE POLICY "care_plan_org" ON "care_plan"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_plan" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "care_plan" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "care_plan_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "care_plan_version_org" ON "care_plan_version";--> statement-breakpoint
CREATE POLICY "care_plan_version_org" ON "care_plan_version"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_plan_version" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "care_plan_version" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "care_plan_signature_org" ON "care_plan_signature";--> statement-breakpoint
CREATE POLICY "care_plan_signature_org" ON "care_plan_signature"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "care_plan_signature" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "care_plan_signature" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "problem" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "problem_org" ON "problem";--> statement-breakpoint
CREATE POLICY "problem_org" ON "problem"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "problem" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "problem" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "goal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "goal_org" ON "goal";--> statement-breakpoint
CREATE POLICY "goal_org" ON "goal"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "goal" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "goal" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "intervention" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "intervention_org" ON "intervention";--> statement-breakpoint
CREATE POLICY "intervention_org" ON "intervention"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "intervention" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "intervention" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table PHI denylist, §3.5).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_care_plan() RETURNS trigger
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
    'care_plan.' || lower(TG_OP),
    'care_plan',
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
ALTER FUNCTION audit_phi_write_care_plan() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_care_plan" AFTER INSERT OR UPDATE OR DELETE ON care_plan
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_care_plan();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_care_plan_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_understanding_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_understanding_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'care_plan_version.' || lower(TG_OP),
    'care_plan_version',
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
ALTER FUNCTION audit_phi_write_care_plan_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_care_plan_version" AFTER INSERT OR UPDATE OR DELETE ON care_plan_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_care_plan_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_care_plan_signature() RETURNS trigger
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
    'care_plan_signature.' || lower(TG_OP),
    'care_plan_signature',
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
ALTER FUNCTION audit_phi_write_care_plan_signature() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_care_plan_signature" AFTER INSERT OR UPDATE OR DELETE ON care_plan_signature
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_care_plan_signature();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_problem() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['description', 'resolution_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['description', 'resolution_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'problem.' || lower(TG_OP),
    'problem',
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
ALTER FUNCTION audit_phi_write_problem() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_problem" AFTER INSERT OR UPDATE OR DELETE ON problem
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_problem();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_goal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['measurable_outcome', 'original_text', 'revised_text', 'status_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['measurable_outcome', 'original_text', 'revised_text', 'status_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'goal.' || lower(TG_OP),
    'goal',
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
ALTER FUNCTION audit_phi_write_goal() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_goal" AFTER INSERT OR UPDATE OR DELETE ON goal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_goal();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_intervention() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['discontinue_reason', 'frequency_text', 'scope_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['discontinue_reason', 'frequency_text', 'scope_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intervention.' || lower(TG_OP),
    'intervention',
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
ALTER FUNCTION audit_phi_write_intervention() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intervention" AFTER INSERT OR UPDATE OR DELETE ON intervention
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intervention();
