-- compat: expand
-- M24-1075 L8A.2C4 Checkpoint B: distinct M8-owned, append-only delivered in-home respite evidence.
-- This table contains clinical source identity and observed timing only. It carries no LOC, rate,
-- quantity conversion, HCPCS/revenue code, payer authorization or billing status. M24 consumes the
-- owner reader and must keep pricing and institutional format explicitly unqualified.

CREATE TABLE encounter_in_home_respite_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL REFERENCES provider_entity(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES location(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  source_encounter_id uuid NOT NULL REFERENCES encounter(id) ON DELETE RESTRICT,
  source_encounter_version bigint NOT NULL,
  service_date date NOT NULL,
  service_started_at timestamptz NOT NULL,
  service_ended_at timestamptz NOT NULL,
  observed_duration_seconds integer NOT NULL,
  time_source text NOT NULL,
  version integer NOT NULL,
  supersedes_id uuid,
  recorded_by_membership_id uuid NOT NULL REFERENCES membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_in_home_respite_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT encounter_in_home_respite_scope_version_uq UNIQUE (organization_id, service_id, version),
  CONSTRAINT encounter_in_home_respite_source_encounter_uq UNIQUE (organization_id, source_encounter_id),
  CONSTRAINT encounter_in_home_respite_supersedes_org_fk
    FOREIGN KEY (organization_id, supersedes_id)
    REFERENCES encounter_in_home_respite_evidence(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT encounter_in_home_respite_facts_valid CHECK (
    version > 0 AND source_encounter_version >= 0 AND observed_duration_seconds > 0 AND
    service_started_at < service_ended_at AND time_source IN ('evv', 'clinician')
  )
);
CREATE UNIQUE INDEX encounter_in_home_respite_initial_version_uq
  ON encounter_in_home_respite_evidence (organization_id, service_id)
  WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX encounter_in_home_respite_single_successor_uq
  ON encounter_in_home_respite_evidence (organization_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE INDEX encounter_in_home_respite_service_window_ix
  ON encounter_in_home_respite_evidence
    (organization_id, provider_entity_id, patient_id, admission_id, service_date);
CREATE INDEX encounter_in_home_respite_source_encounter_ix
  ON encounter_in_home_respite_evidence (organization_id, source_encounter_id);

ALTER TABLE encounter_in_home_respite_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE encounter_in_home_respite_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY encounter_in_home_respite_evidence_org_isolation
  ON encounter_in_home_respite_evidence FOR ALL TO chartwarden_app, chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON encounter_in_home_respite_evidence TO chartwarden_app;
GRANT SELECT, DELETE ON encounter_in_home_respite_evidence TO chartwarden_destruction;
REVOKE UPDATE, DELETE, TRUNCATE ON encounter_in_home_respite_evidence FROM chartwarden_app;
REVOKE ALL ON encounter_in_home_respite_evidence FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_encounter_in_home_respite_evidence_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_encounter encounter%ROWTYPE;
  v_timezone text;
  v_previous encounter_in_home_respite_evidence%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'in-home respite clinical evidence is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT pg_has_role(current_user, 'chartwarden_destruction', 'member') THEN
      RAISE EXCEPTION 'in-home respite clinical evidence deletion requires the destruction role'
        USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'm8-in-home-respite-scope:' || OLD.organization_id::text || ':' || OLD.provider_entity_id::text || ':' ||
      OLD.patient_id::text || ':' || OLD.admission_id::text, 0));
    RETURN OLD;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid OR
     NEW.recorded_by_membership_id IS NULL OR NEW.version < 1 THEN
    RAISE EXCEPTION 'in-home respite source identity is outside the current organization'
      USING ERRCODE = '23514';
  END IF;
  -- M24's source reader takes this same scope lock before pricing. Inserts and corrections therefore
  -- cannot race a claim assembly, and the app role does not need UPDATE on this append-only table for
  -- SELECT FOR SHARE.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'm8-in-home-respite-scope:' || NEW.organization_id::text || ':' || NEW.provider_entity_id::text || ':' ||
    NEW.patient_id::text || ':' || NEW.admission_id::text, 0));
  -- The route authenticates the acting member; the database guard verifies that the cited membership
  -- exists and is active in this organization. A caller-set app.user_id GUC is not treated as identity.
  IF NOT EXISTS (
    SELECT 1 FROM membership m
     WHERE m.id = NEW.recorded_by_membership_id
       AND m.organization_id = NEW.organization_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'in-home respite evidence requires an active organization membership'
      USING ERRCODE = '23514';
  END IF;
  SELECT e.*
    INTO v_encounter
    FROM encounter e
    JOIN location l ON l.id = e.location_id AND l.provider_entity_id = e.provider_entity_id
   WHERE e.id = NEW.source_encounter_id AND e.organization_id = NEW.organization_id
     AND e.provider_entity_id = NEW.provider_entity_id AND e.location_id = NEW.location_id
     AND e.patient_id = NEW.patient_id AND e.admission_id = NEW.admission_id
     AND e.version = NEW.source_encounter_version
     AND e.status IN ('signed', 'cosigned') AND e.signed_at IS NOT NULL
     AND e.voided_at IS NULL AND e.started_at IS NOT NULL AND e.ended_at IS NOT NULL
     AND e.time_source IN ('evv', 'clinician')
     AND e.started_at = NEW.service_started_at AND e.ended_at = NEW.service_ended_at
     AND e.time_source = NEW.time_source
     AND (e.started_at AT TIME ZONE l.timezone)::date = NEW.service_date
     AND extract(epoch FROM (e.ended_at - e.started_at)) = NEW.observed_duration_seconds
     AND l.provider_entity_id = NEW.provider_entity_id
   FOR SHARE OF e, l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'in-home respite evidence requires a matching signed delivered-service encounter'
      USING ERRCODE = '23514';
  END IF;
  SELECT l.timezone
    INTO v_timezone
    FROM location l
   WHERE l.id = NEW.location_id AND l.provider_entity_id = NEW.provider_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'in-home respite evidence requires an active service location'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version = 1 THEN
    IF NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'initial in-home respite evidence cannot supersede another version'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.supersedes_id IS NULL THEN
      RAISE EXCEPTION 'corrected in-home respite evidence must identify its predecessor'
        USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'm8-in-home-respite:' || NEW.organization_id::text || ':' || NEW.service_id::text, 0));
    SELECT * INTO v_previous
      FROM encounter_in_home_respite_evidence p
     WHERE p.organization_id = NEW.organization_id AND p.id = NEW.supersedes_id
       AND p.service_id = NEW.service_id AND p.version = NEW.version - 1
       AND p.provider_entity_id = NEW.provider_entity_id AND p.patient_id = NEW.patient_id
       AND p.admission_id = NEW.admission_id
       AND NOT EXISTS (
         SELECT 1 FROM encounter_in_home_respite_evidence n
          WHERE n.organization_id = p.organization_id AND n.supersedes_id = p.id
        );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'in-home respite correction is stale or does not extend the current evidence head'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_encounter_in_home_respite_evidence_write() FROM PUBLIC;
CREATE TRIGGER trg_guard_encounter_in_home_respite_evidence_write
  BEFORE INSERT OR UPDATE OR DELETE ON encounter_in_home_respite_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_encounter_in_home_respite_evidence_write();

CREATE OR REPLACE FUNCTION audit_phi_write_encounter_in_home_respite_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
  v_id uuid := COALESCE(NEW.id, OLD.id);
  v_version integer := COALESCE(NEW.version, OLD.version);
BEGIN
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    v_org, NULLIF(current_setting('app.user_id', true), '')::uuid, 'user',
    'encounter_in_home_respite_evidence.' || lower(TG_OP),
    'encounter_in_home_respite_evidence', v_id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info',
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object('version', v_version) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object('version', v_version, 'recorded', true) END,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')
    ),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;
ALTER FUNCTION audit_phi_write_encounter_in_home_respite_evidence() OWNER TO chartwarden_audit_writer;
REVOKE ALL ON FUNCTION audit_phi_write_encounter_in_home_respite_evidence() FROM PUBLIC;
CREATE TRIGGER trg_audit_encounter_in_home_respite_evidence
  AFTER INSERT OR DELETE ON encounter_in_home_respite_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_in_home_respite_evidence();

COMMENT ON TABLE encounter_in_home_respite_evidence IS
  'M8 append-only delivered in-home respite evidence sourced from signed M8 encounters; no billing or payer qualification.';
