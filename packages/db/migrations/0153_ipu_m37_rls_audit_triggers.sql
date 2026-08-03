-- M37 §3.5/§3.6 — RLS + grants on all 26 owned tables and the M4 write-audit trigger on each.
--
-- 1. RLS (ADR-0010 D2): every M37 table is TENANT-SCOPED PHI/compliance data. One `FOR ALL` policy keyed
--    ONLY on canonical app.org_id (set by withOrgContext()). wardenx_app gets SELECT/INSERT/UPDATE/DELETE
--    (the §3.7 ipu_record eraser DELETEs on offboarding); wardenx_admin gets ALL. For the four
--    partitioned tables the policy + grants are declared on the PARTITIONED PARENT and propagate to every
--    partition (PG11+, the M35 usage_event / M28 fhir_client_session precedent).
--
-- 2. M4 write-audit triggers (§3.6). Retention class `compliance` (the audit_retention_class enum is
--    {operational,compliance,legal_hold} — the plan's "phi_ipu_clinical" maps to compliance).
--    • FOURTEEN unpartitioned tables with no denylisted free-text use M1's baseline wardenx_audit_trigger().
--    • EIGHT unpartitioned tables carry §3.6-denylisted free-text PHI (D11) and get a GENERATED scrub
--      function that audit_scrub()s those columns out of before/after so PHI never enters audit_event.
--    • The FOUR partitioned tables get a GENERATED function that HARD-CODES the parent name — M1's
--      baseline would stamp TG_TABLE_NAME = the dated partition (the M32 ai_token_ledger lesson) — and
--      also scrubs their denylisted free-text.

-- ============================================================================================
-- 1. RLS policies + grants — all 26 tenant-scoped.
-- ============================================================================================
ALTER TABLE "inpatient_unit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inpatient_unit_org" ON "inpatient_unit";
CREATE POLICY "inpatient_unit_org" ON "inpatient_unit" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "inpatient_unit" TO wardenx_app;
GRANT ALL ON "inpatient_unit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_room" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_room_org" ON "ipu_room";
CREATE POLICY "ipu_room_org" ON "ipu_room" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_room" TO wardenx_app;
GRANT ALL ON "ipu_room" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_bed" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_bed_org" ON "ipu_bed";
CREATE POLICY "ipu_bed_org" ON "ipu_bed" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_bed" TO wardenx_app;
GRANT ALL ON "ipu_bed" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_admission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_admission_org" ON "ipu_admission";
CREATE POLICY "ipu_admission_org" ON "ipu_admission" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_admission" TO wardenx_app;
GRANT ALL ON "ipu_admission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_bed_assignment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_bed_assignment_org" ON "ipu_bed_assignment";
CREATE POLICY "ipu_bed_assignment_org" ON "ipu_bed_assignment" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_bed_assignment" TO wardenx_app;
GRANT ALL ON "ipu_bed_assignment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_admission_transition" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_admission_transition_org" ON "ipu_admission_transition";
CREATE POLICY "ipu_admission_transition_org" ON "ipu_admission_transition" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_admission_transition" TO wardenx_app;
GRANT ALL ON "ipu_admission_transition" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "gip_admission_criteria" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gip_admission_criteria_org" ON "gip_admission_criteria";
CREATE POLICY "gip_admission_criteria_org" ON "gip_admission_criteria" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "gip_admission_criteria" TO wardenx_app;
GRANT ALL ON "gip_admission_criteria" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "gip_criteria_reassessment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gip_criteria_reassessment_org" ON "gip_criteria_reassessment";
CREATE POLICY "gip_criteria_reassessment_org" ON "gip_criteria_reassessment" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "gip_criteria_reassessment" TO wardenx_app;
GRANT ALL ON "gip_criteria_reassessment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "irc_episode" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "irc_episode_org" ON "irc_episode";
CREATE POLICY "irc_episode_org" ON "irc_episode" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "irc_episode" TO wardenx_app;
GRANT ALL ON "irc_episode" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_remote_inpatient_episode" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_remote_inpatient_episode_org" ON "ipu_remote_inpatient_episode";
CREATE POLICY "ipu_remote_inpatient_episode_org" ON "ipu_remote_inpatient_episode" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_remote_inpatient_episode" TO wardenx_app;
GRANT ALL ON "ipu_remote_inpatient_episode" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_shift" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_shift_org" ON "ipu_shift";
CREATE POLICY "ipu_shift_org" ON "ipu_shift" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_shift" TO wardenx_app;
GRANT ALL ON "ipu_shift" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_staff_assignment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_staff_assignment_org" ON "ipu_staff_assignment";
CREATE POLICY "ipu_staff_assignment_org" ON "ipu_staff_assignment" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_staff_assignment" TO wardenx_app;
GRANT ALL ON "ipu_staff_assignment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_rn_coverage_window" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_rn_coverage_window_org" ON "ipu_rn_coverage_window";
CREATE POLICY "ipu_rn_coverage_window_org" ON "ipu_rn_coverage_window" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_rn_coverage_window" TO wardenx_app;
GRANT ALL ON "ipu_rn_coverage_window" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_iv_safety_overlay" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_iv_safety_overlay_org" ON "ipu_iv_safety_overlay";
CREATE POLICY "ipu_iv_safety_overlay_org" ON "ipu_iv_safety_overlay" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_iv_safety_overlay" TO wardenx_app;
GRANT ALL ON "ipu_iv_safety_overlay" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_restraint_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_restraint_event_org" ON "ipu_restraint_event";
CREATE POLICY "ipu_restraint_event_org" ON "ipu_restraint_event" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_restraint_event" TO wardenx_app;
GRANT ALL ON "ipu_restraint_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_restraint_reassessment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_restraint_reassessment_org" ON "ipu_restraint_reassessment";
CREATE POLICY "ipu_restraint_reassessment_org" ON "ipu_restraint_reassessment" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_restraint_reassessment" TO wardenx_app;
GRANT ALL ON "ipu_restraint_reassessment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_visitor_restriction" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_visitor_restriction_org" ON "ipu_visitor_restriction";
CREATE POLICY "ipu_visitor_restriction_org" ON "ipu_visitor_restriction" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_visitor_restriction" TO wardenx_app;
GRANT ALL ON "ipu_visitor_restriction" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_equipment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_equipment_org" ON "ipu_equipment";
CREATE POLICY "ipu_equipment_org" ON "ipu_equipment" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_equipment" TO wardenx_app;
GRANT ALL ON "ipu_equipment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_equipment_maintenance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_equipment_maintenance_org" ON "ipu_equipment_maintenance";
CREATE POLICY "ipu_equipment_maintenance_org" ON "ipu_equipment_maintenance" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_equipment_maintenance" TO wardenx_app;
GRANT ALL ON "ipu_equipment_maintenance" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_equipment_inspection" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_equipment_inspection_org" ON "ipu_equipment_inspection";
CREATE POLICY "ipu_equipment_inspection_org" ON "ipu_equipment_inspection" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_equipment_inspection" TO wardenx_app;
GRANT ALL ON "ipu_equipment_inspection" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_body_release" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_body_release_org" ON "ipu_body_release";
CREATE POLICY "ipu_body_release_org" ON "ipu_body_release" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_body_release" TO wardenx_app;
GRANT ALL ON "ipu_body_release" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_census_snapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_census_snapshot_org" ON "ipu_census_snapshot";
CREATE POLICY "ipu_census_snapshot_org" ON "ipu_census_snapshot" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_census_snapshot" TO wardenx_app;
GRANT ALL ON "ipu_census_snapshot" TO wardenx_admin;--> statement-breakpoint
-- Partitioned parents (policy + grants propagate to every partition).--> statement-breakpoint
ALTER TABLE "ipu_admission_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_admission_state_history_org" ON "ipu_admission_state_history";
CREATE POLICY "ipu_admission_state_history_org" ON "ipu_admission_state_history" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_admission_state_history" TO wardenx_app;
GRANT ALL ON "ipu_admission_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_bed_cleaning_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_bed_cleaning_event_org" ON "ipu_bed_cleaning_event";
CREATE POLICY "ipu_bed_cleaning_event_org" ON "ipu_bed_cleaning_event" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_bed_cleaning_event" TO wardenx_app;
GRANT ALL ON "ipu_bed_cleaning_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_visitor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_visitor_org" ON "ipu_visitor";
CREATE POLICY "ipu_visitor_org" ON "ipu_visitor" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_visitor" TO wardenx_app;
GRANT ALL ON "ipu_visitor" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ipu_meal_service" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ipu_meal_service_org" ON "ipu_meal_service";
CREATE POLICY "ipu_meal_service_org" ON "ipu_meal_service" FOR ALL TO wardenx_app USING (organization_id = current_setting('app.org_id', true)::uuid) WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ipu_meal_service" TO wardenx_app;
GRANT ALL ON "ipu_meal_service" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2a. Baseline M4 write-audit triggers (14 unpartitioned tables, no denylisted free-text).
-- ============================================================================================
CREATE TRIGGER "inpatient_unit_audit" AFTER INSERT OR UPDATE OR DELETE ON inpatient_unit FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_room_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_room FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_bed_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_bed FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_admission_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_admission FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_bed_assignment_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_bed_assignment FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_admission_transition_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_admission_transition FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_shift_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_shift FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_staff_assignment_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_staff_assignment FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_rn_coverage_window_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_rn_coverage_window FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_iv_safety_overlay_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_iv_safety_overlay FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_remote_inpatient_episode_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_remote_inpatient_episode FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_equipment_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_equipment FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_equipment_maintenance_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_equipment_maintenance FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ipu_census_snapshot_audit" AFTER INSERT OR UPDATE OR DELETE ON ipu_census_snapshot FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- ============================================================================================
-- 2b. GENERATED scrub triggers — 8 unpartitioned tables with §3.6-denylisted free-text PHI (D11).
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_gip_admission_criteria() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['data']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'gip_admission_criteria.' || lower(TG_OP), 'gip_admission_criteria', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_gip_admission_criteria() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_gip_admission_criteria" AFTER INSERT OR UPDATE OR DELETE ON gip_admission_criteria FOR EACH ROW EXECUTE FUNCTION audit_phi_write_gip_admission_criteria();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_gip_criteria_reassessment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['rationale']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'gip_criteria_reassessment.' || lower(TG_OP), 'gip_criteria_reassessment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_gip_criteria_reassessment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_gip_criteria_reassessment" AFTER INSERT OR UPDATE OR DELETE ON gip_criteria_reassessment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_gip_criteria_reassessment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_irc_episode() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['cap_override_reason','closure_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'irc_episode.' || lower(TG_OP), 'irc_episode', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_irc_episode() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_irc_episode" AFTER INSERT OR UPDATE OR DELETE ON irc_episode FOR EACH ROW EXECUTE FUNCTION audit_phi_write_irc_episode();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_restraint_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['restraint_justification_text','released_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_restraint_event.' || lower(TG_OP), 'ipu_restraint_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_restraint_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_restraint_event" AFTER INSERT OR UPDATE OR DELETE ON ipu_restraint_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_restraint_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_restraint_reassessment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_restraint_reassessment.' || lower(TG_OP), 'ipu_restraint_reassessment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_restraint_reassessment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_restraint_reassessment" AFTER INSERT OR UPDATE OR DELETE ON ipu_restraint_reassessment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_restraint_reassessment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_visitor_restriction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['rationale']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_visitor_restriction.' || lower(TG_OP), 'ipu_visitor_restriction', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_visitor_restriction() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_visitor_restriction" AFTER INSERT OR UPDATE OR DELETE ON ipu_visitor_restriction FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_visitor_restriction();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_equipment_inspection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_equipment_inspection.' || lower(TG_OP), 'ipu_equipment_inspection', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_equipment_inspection() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_equipment_inspection" AFTER INSERT OR UPDATE OR DELETE ON ipu_equipment_inspection FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_equipment_inspection();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_body_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['released_to_representative_name']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_body_release.' || lower(TG_OP), 'ipu_body_release', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_body_release() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_body_release" AFTER INSERT OR UPDATE OR DELETE ON ipu_body_release FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_body_release();--> statement-breakpoint

-- ============================================================================================
-- 2c. GENERATED parent-hardcoded scrub triggers — the 4 partitioned tables (M32 ai_token_ledger lesson).
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_admission_state_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason','metadata']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'ipu_admission_state_history.' || lower(TG_OP), 'ipu_admission_state_history', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_admission_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_admission_state_history" AFTER INSERT OR UPDATE OR DELETE ON ipu_admission_state_history FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_admission_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_bed_cleaning_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'ipu_bed_cleaning_event.' || lower(TG_OP), 'ipu_bed_cleaning_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_bed_cleaning_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_bed_cleaning_event" AFTER INSERT OR UPDATE OR DELETE ON ipu_bed_cleaning_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_bed_cleaning_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_visitor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['visitor_name','relationship_other_text','restriction_applied_text']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_visitor.' || lower(TG_OP), 'ipu_visitor', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_visitor() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_visitor" AFTER INSERT OR UPDATE OR DELETE ON ipu_visitor FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_visitor();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ipu_meal_service() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['refusal_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'user', 'ipu_meal_service.' || lower(TG_OP), 'ipu_meal_service', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''), 'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_ipu_meal_service() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ipu_meal_service" AFTER INSERT OR UPDATE OR DELETE ON ipu_meal_service FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ipu_meal_service();
