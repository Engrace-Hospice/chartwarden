-- M20 Field Safety §3.5 / §3.6 / §8.8.1 / §2.3 — RLS + grants on all thirteen owned tables, the M4
-- write-audit trigger (generateAuditTrigger shape) on each with the §3.6 denylists and the §8.8.1 retention
-- classes, and the §2.3 active-SOS guard on `safety_sos_location_stream`. Enums + tables land in 0110.
--
-- 1. RLS (§3.5 / ADR-0010 D2): row visibility keys ONLY on app.org_id, set by withOrgContext(). Eight of
--    the thirteen tables carry provider_entity_id + location_id for the §4.3 seam rollups and M36 routing,
--    but the RLS pivot stays organization_id ALONE — a second permissive policy would OR, not AND.
--    Everything §6/§8.2 layers on top (`safety_supervisor_or_above`, `active_sos_responder`,
--    `field_eligible_for_sos`, `clinician_self`, the §8.7 coordinate-read gate) is M3 ABAC at the route,
--    never RLS: RLS is the tenant moat, ABAC is the per-record filter.
--
--    ONE SHAPE, not two. Unlike M19 — whose `triage_protocol` pair is a platform-floor-plus-overlay needing
--    three command-split policies — EVERY M20 table gets the canonical org policy, because M20 has NO
--    org-NULL row anywhere: M20-F03 struck the platform `safety_policy` row (the floor is the
--    `SAFETY_POLICY_FLOOR` code constant) and §3.2 Phase E routes platform high-risk-area polygons to a
--    separate pattern-2 table the manifest does not own. There is therefore nothing here that an
--    `is_system_locked = true OR organization_id = …` read policy would be for, and adding one would be the
--    ADR-0010 D3 shape for no gain.
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on nothing here. (F-043/#103: migration 0238
--    later adds DELETE on `safety_check_in_schedule` alone — a `proposed` obligation is a plan the system
--    MADE, not evidence of anything that happened, and `consumers/schedule-plan.ts` shows no member of
--    `safety_check_in_state` can truthfully say "invalidated". The M4 trigger below fires on DELETE, so the
--    retirement stays on the record. Every other table keeps the posture this paragraph describes.)
--    Four tables get SELECT/INSERT ONLY — `safety_policy_version`, `safety_sos_location_stream`, `safety_sos_alert_state_history` and
--    `safety_incident_state_history` are append-only per §8.8.1 ("INSERT only"), a policy correction is a
--    NEW version row and a lifecycle correction is a NEW history row, and withholding UPDATE makes that a
--    permission error rather than a code-review convention. In particular an UPDATE grant on
--    `safety_policy_version` would let a tenant retroactively rewrite the cadence that was in force during
--    a past incident, which is the exact thing the version table exists to make impossible. Destruction runs
--    through the admin-role eraseFn (§3.7), which is why the app role gets DELETE on no EVIDENCE table in
--    M20 — including on the location stream, whose resolve+90d physical delete is a privileged sweep.
--
-- 2. M4 write-audit triggers (§3.6 / §8.8.1). Eleven tables stamp `compliance`; `safety_supervisor_subscription`
--    and `safety_high_risk_area` stamp `operational`, matching `M20_AUDIT_RETENTION_CLASS` in @wardenx/types
--    and §8.8.4's summary (3 years from deactivation and 5 years from retirement respectively — neither is
--    survey evidence about a person).
--
--    `safety_check_in` IS THE CASE THE PER-TABLE TRIGGER CANNOT SPLIT. §3.7 and §8.8.1 both file it two
--    ways: `compliance` for SOS-bracketed and `concerned_*` rows, `operational` for routine `ok` rows. The
--    M4 generator bakes the class into the function per TABLE and takes no row predicate, and a trigger that
--    decided per row would have to re-read the row's own state mid-write — the conditional that fails OPEN
--    (the M19-T01 `answer_value_text` finding). So it stamps the SAFER class, `compliance`, and the
--    routine-purge lives where it can see the row: an M20 cron predicated on `is_part_of_sos_bracket = false
--    AND status = 'ok'` (M20-T03, served by the `sci_purge_scan_idx` partial index 0110 creates). The fail
--    direction is the only one available — over-retaining a routine "I'm OK" costs storage; under-retaining
--    an SOS bracket costs the agency the workers-comp timeline §1.1 exists to preserve. The same argument
--    applies to `safety_acknowledgment`, whose §3.7 class is "matches parent target's".
--
--    Denylists mirror `M20_AUDIT_DENYLIST` (@wardenx/types) VERBATIM so the code-side export view and the
--    DB-side scrub cannot drift:
--      safety_check_in                    concern_note / posted_coordinates_cipher / posted_coordinates_accuracy_m
--      safety_sos_alert                   posted_coordinates_cipher / resolution_narrative_cipher / acknowledger_dispatch_payload_cipher
--      safety_sos_location_stream         coordinates_cipher / device_telemetry
--      safety_sos_alert_state_history     reason
--      safety_incident                    narrative_cipher / witnesses_cipher / action_plan_cipher / location_description / reopen_reason / workers_comp_claim_reference
--      safety_incident_state_history      reason
--      safety_acknowledgment              action_taken
--      safety_policy_version              edit_reason
--      safety_high_risk_area              advisory_message
--      safety_emergency_contact_consent   consent_scope_detail
--      (safety_policy / safety_check_in_schedule / safety_supervisor_subscription — structural only)
--
--    `posted_coordinates_accuracy_m` is denylisted on `safety_check_in` and NOT on `safety_sos_alert`,
--    which looks inconsistent and is §3.6 read literally: on a routine check-in the accuracy radius is the
--    only unencrypted thing said about a captured location, so it goes; on an SOS the coordinate capture is
--    itself the consented, expected act and the accuracy is what a responder's after-action review reads.
--
--    NOT denylisted, deliberately, and each for the same reason: `lifecycle_state` / `cancel_status` /
--    `category` / `severity` / `osha_reportable` / `outcome` / `target_kind` / `status` / `kind` are the
--    exact fields a surveyor, an insurer or a deposition reads (§8.8.1 says so per table), and a denylisted
--    enum makes the ledger useless for the purpose it exists to serve. `is_part_of_sos_bracket` is captured
--    verbatim because it is the retention ROUTER — a trail that cannot say which class a row was filed
--    under cannot prove the purge was lawful. And `acknowledgment_text_snapshot` stays captured because it
--    is the policy text the clinician was shown at grant, which is the one thing a consent dispute turns on.
--
--    Every entry is UNCONDITIONAL: §3.7's retention split is row-conditional but a denylist cannot be, for
--    the same fail-open reason as above.
--
-- 3. The §2.3 active-SOS guard — `m20_enforce_sos_stream_active()`. §2.3's enforcement column says "DB
--    CHECK referencing SOS lifecycle_state"; a CHECK cannot read another table, so it is a BEFORE INSERT
--    trigger. It is not a formality: `safety_sos_location_stream` is continuous location tracking of a
--    named worker (§8.7), and the D6 consent that authorizes it is scoped to an ACTIVE SOS. A stream row
--    written after the alert resolved is surveillance the clinician did not consent to, and it would arrive
--    through exactly the path §8.7 exists to close — a sampler that kept running because nobody told it to
--    stop. It fails CLOSED in both directions: an unknown parent (or one hidden from the caller by RLS)
--    raises rather than inserting.
--
--    The OPEN set here is `SAFETY_SOS_OPEN_STATES` from @wardenx/types verbatim, `emergency_terminus`
--    INCLUDED. The terminus is an OPEN state per M20-F05/S13 — it re-escalates on a loop and exits only on
--    acknowledgment, never on timeout — and it is precisely the state during which knowing where the
--    clinician is matters most. Excluding it would cut the location feed at the worst possible moment.
-- 1. RLS policies + grants (§3.5).--> statement-breakpoint
ALTER TABLE "safety_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_policy_org" ON "safety_policy";
CREATE POLICY "safety_policy_org" ON "safety_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_policy" TO wardenx_app;
GRANT ALL ON "safety_policy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_policy_version" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_policy_version_org" ON "safety_policy_version";
CREATE POLICY "safety_policy_version_org" ON "safety_policy_version"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "safety_policy_version" TO wardenx_app;
GRANT ALL ON "safety_policy_version" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_check_in_schedule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_check_in_schedule_org" ON "safety_check_in_schedule";
CREATE POLICY "safety_check_in_schedule_org" ON "safety_check_in_schedule"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_check_in_schedule" TO wardenx_app;
GRANT ALL ON "safety_check_in_schedule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_check_in" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_check_in_org" ON "safety_check_in";
CREATE POLICY "safety_check_in_org" ON "safety_check_in"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_check_in" TO wardenx_app;
GRANT ALL ON "safety_check_in" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_sos_alert" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_sos_alert_org" ON "safety_sos_alert";
CREATE POLICY "safety_sos_alert_org" ON "safety_sos_alert"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_sos_alert" TO wardenx_app;
GRANT ALL ON "safety_sos_alert" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_sos_location_stream" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_sos_location_stream_org" ON "safety_sos_location_stream";
CREATE POLICY "safety_sos_location_stream_org" ON "safety_sos_location_stream"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "safety_sos_location_stream" TO wardenx_app;
GRANT ALL ON "safety_sos_location_stream" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_sos_alert_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_sos_alert_state_history_org" ON "safety_sos_alert_state_history";
CREATE POLICY "safety_sos_alert_state_history_org" ON "safety_sos_alert_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "safety_sos_alert_state_history" TO wardenx_app;
GRANT ALL ON "safety_sos_alert_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_incident" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_incident_org" ON "safety_incident";
CREATE POLICY "safety_incident_org" ON "safety_incident"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_incident" TO wardenx_app;
GRANT ALL ON "safety_incident" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_incident_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_incident_state_history_org" ON "safety_incident_state_history";
CREATE POLICY "safety_incident_state_history_org" ON "safety_incident_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "safety_incident_state_history" TO wardenx_app;
GRANT ALL ON "safety_incident_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_acknowledgment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_acknowledgment_org" ON "safety_acknowledgment";
CREATE POLICY "safety_acknowledgment_org" ON "safety_acknowledgment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_acknowledgment" TO wardenx_app;
GRANT ALL ON "safety_acknowledgment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_supervisor_subscription" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_supervisor_subscription_org" ON "safety_supervisor_subscription";
CREATE POLICY "safety_supervisor_subscription_org" ON "safety_supervisor_subscription"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_supervisor_subscription" TO wardenx_app;
GRANT ALL ON "safety_supervisor_subscription" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_high_risk_area" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_high_risk_area_org" ON "safety_high_risk_area";
CREATE POLICY "safety_high_risk_area_org" ON "safety_high_risk_area"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_high_risk_area" TO wardenx_app;
GRANT ALL ON "safety_high_risk_area" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "safety_emergency_contact_consent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_emergency_contact_consent_org" ON "safety_emergency_contact_consent";
CREATE POLICY "safety_emergency_contact_consent_org" ON "safety_emergency_contact_consent"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "safety_emergency_contact_consent" TO wardenx_app;
GRANT ALL ON "safety_emergency_contact_consent" TO wardenx_admin;--> statement-breakpoint

-- 2. M4 write-audit triggers (§3.6 / §8.8.1) — one generated function per table, denylists per M20_AUDIT_DENYLIST.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_policy() RETURNS trigger
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
    'safety_policy.' || lower(TG_OP),
    'safety_policy',
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
ALTER FUNCTION audit_phi_write_safety_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_policy" AFTER INSERT OR UPDATE OR DELETE ON safety_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_policy();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_policy_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['edit_reason']::text[];
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
    'safety_policy_version.' || lower(TG_OP),
    'safety_policy_version',
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
ALTER FUNCTION audit_phi_write_safety_policy_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_policy_version" AFTER INSERT OR UPDATE OR DELETE ON safety_policy_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_policy_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_check_in_schedule() RETURNS trigger
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
    'safety_check_in_schedule.' || lower(TG_OP),
    'safety_check_in_schedule',
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
ALTER FUNCTION audit_phi_write_safety_check_in_schedule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_check_in_schedule" AFTER INSERT OR UPDATE OR DELETE ON safety_check_in_schedule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_check_in_schedule();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_check_in() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['concern_note','posted_coordinates_cipher','posted_coordinates_accuracy_m']::text[];
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
    'safety_check_in.' || lower(TG_OP),
    'safety_check_in',
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
ALTER FUNCTION audit_phi_write_safety_check_in() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_check_in" AFTER INSERT OR UPDATE OR DELETE ON safety_check_in
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_check_in();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_sos_alert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['posted_coordinates_cipher','resolution_narrative_cipher','acknowledger_dispatch_payload_cipher']::text[];
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
    'safety_sos_alert.' || lower(TG_OP),
    'safety_sos_alert',
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
ALTER FUNCTION audit_phi_write_safety_sos_alert() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_sos_alert" AFTER INSERT OR UPDATE OR DELETE ON safety_sos_alert
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_sos_alert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_sos_location_stream() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['coordinates_cipher','device_telemetry']::text[];
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
    'safety_sos_location_stream.' || lower(TG_OP),
    'safety_sos_location_stream',
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
ALTER FUNCTION audit_phi_write_safety_sos_location_stream() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_sos_location_stream" AFTER INSERT OR UPDATE OR DELETE ON safety_sos_location_stream
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_sos_location_stream();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_sos_alert_state_history() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reason']::text[];
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
    'safety_sos_alert_state_history.' || lower(TG_OP),
    'safety_sos_alert_state_history',
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
ALTER FUNCTION audit_phi_write_safety_sos_alert_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_sos_alert_state_history" AFTER INSERT OR UPDATE OR DELETE ON safety_sos_alert_state_history
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_sos_alert_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_incident() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['narrative_cipher','witnesses_cipher','action_plan_cipher','location_description','reopen_reason','workers_comp_claim_reference']::text[];
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
    'safety_incident.' || lower(TG_OP),
    'safety_incident',
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
ALTER FUNCTION audit_phi_write_safety_incident() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_incident" AFTER INSERT OR UPDATE OR DELETE ON safety_incident
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_incident();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_incident_state_history() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reason']::text[];
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
    'safety_incident_state_history.' || lower(TG_OP),
    'safety_incident_state_history',
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
ALTER FUNCTION audit_phi_write_safety_incident_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_incident_state_history" AFTER INSERT OR UPDATE OR DELETE ON safety_incident_state_history
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_incident_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_acknowledgment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['action_taken']::text[];
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
    'safety_acknowledgment.' || lower(TG_OP),
    'safety_acknowledgment',
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
ALTER FUNCTION audit_phi_write_safety_acknowledgment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_acknowledgment" AFTER INSERT OR UPDATE OR DELETE ON safety_acknowledgment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_acknowledgment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_supervisor_subscription() RETURNS trigger
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
    'safety_supervisor_subscription.' || lower(TG_OP),
    'safety_supervisor_subscription',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_safety_supervisor_subscription() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_supervisor_subscription" AFTER INSERT OR UPDATE OR DELETE ON safety_supervisor_subscription
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_supervisor_subscription();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_high_risk_area() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['advisory_message']::text[];
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
    'safety_high_risk_area.' || lower(TG_OP),
    'safety_high_risk_area',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_safety_high_risk_area() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_high_risk_area" AFTER INSERT OR UPDATE OR DELETE ON safety_high_risk_area
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_high_risk_area();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_safety_emergency_contact_consent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['consent_scope_detail']::text[];
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
    'safety_emergency_contact_consent.' || lower(TG_OP),
    'safety_emergency_contact_consent',
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
ALTER FUNCTION audit_phi_write_safety_emergency_contact_consent() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_safety_emergency_contact_consent" AFTER INSERT OR UPDATE OR DELETE ON safety_emergency_contact_consent
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_safety_emergency_contact_consent();--> statement-breakpoint

-- 3. The §2.3 active-SOS guard on the continuous-location stream (see the header).--> statement-breakpoint
CREATE OR REPLACE FUNCTION m20_enforce_sos_stream_active() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
BEGIN
  SELECT "lifecycle_state"::text INTO v_state
    FROM safety_sos_alert WHERE id = NEW.sos_alert_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'M20_SOS_STREAM_UNKNOWN_ALERT: %', NEW.sos_alert_id
      USING ERRCODE = '23514';
  END IF;
  -- SAFETY_SOS_OPEN_STATES (@wardenx/types), `emergency_terminus` included.
  IF v_state NOT IN (
    'raised','cancel_window_open','acknowledging','acknowledged',
    'escalation_tier_1','escalation_tier_2','escalation_tier_3',
    'emergency_terminus','resolving'
  ) THEN
    RAISE EXCEPTION 'M20_SOS_STREAM_NOT_ACTIVE: alert % is %', NEW.sos_alert_id, v_state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_m20_sos_stream_active"
  BEFORE INSERT ON safety_sos_location_stream
  FOR EACH ROW EXECUTE FUNCTION m20_enforce_sos_stream_active();
