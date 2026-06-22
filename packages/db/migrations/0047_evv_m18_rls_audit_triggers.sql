-- M18 EVV §3.3/§3.5/§3.6 (RLS + grants) + the evv_event PARTITION BY RANGE conversion + the §3.2 Phase C
-- append-only immutability trigger + the per-LEAF partial-UNIQUE backstops (D2 active-pair / D5 offline
-- idempotency) + M4 write-audit triggers — M18-T02.
--
-- Tables/enums/indexes/FKs land in 0046 (drizzle-generated). This migration locks:
--   • the §3.2 Phase A / D12 PARTITION BY RANGE conversion of `evv_event` (by event_at). Postgres requires
--     PARTITION BY at CREATE time, so (M17 visit precedent, 0045) we drop the plain table 0046 created and
--     re-create it partitioned, same columns/PK/FKs/indexes. Monthly partitions (current + 12 forward) + a
--     DEFAULT catch-all, created dynamically via format(%I) so the static phi-guards scan does not mis-detect
--     a partition child as a separate un-triggered org table (row triggers on the partitioned parent
--     propagate to every partition, PG11+). The M1 partition-maintenance cron rotates new months. Because
--     `evv_event` is partitioned, the satellite references TO it (evv_geofence_evaluation.evv_event_id,
--     evv_aggregator_submission.check_in/out_event_id) carry NO SQL FK — plain uuid, app-validated;
--   • the §3.2 Phase E per-LEAF partial-UNIQUE backstops. Postgres forbids a partial UNIQUE index that omits
--     the partition key on the partitioned PARENT, so the D2 active-pair invariant
--     (organization_id, visit_id, kind) WHERE superseded_by_event_id IS NULL and the D5 offline idempotency
--     (organization_id, evv_device_id, local_id) WHERE local_id IS NOT NULL are added to each LEAF partition
--     via add_evv_event_unique_indexes(); a check-in and its check-out fall in the same event_at month (one
--     partition), so per-partition enforcement is the correct backstop and the app-layer pairing lookup gives
--     the friendly error first (M17 per-leaf EXCLUDE precedent);
--   • the §3.2 Phase C append-only immutability trigger on `evv_event`: BEFORE UPDATE refuses any change to a
--     column other than superseded_at / superseded_by_event_id (the correction-of-record supersede markers,
--     §2.3); BEFORE DELETE refuses entirely. Correction is an append (a NEW row with replaces_event_id), never
--     an in-place edit — the M8/M11 append-only posture;
--   • standard app.org_id org-scope RLS on all six tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()). evv_event is the only PHI-bearing table by the three-column rule
--     (it carries patient_id) and so carries provider_entity_id + location_id NOT NULL; the other five are
--     org-scoped (geofence_evaluation/missing_resolution/aggregator_submission joinable to PHI only via
--     visit_id/evv_event_id), tenant-config (geofence_policy), or membership-scoped (device). The RLS pivot is
--     organization_id alone (§3.5);
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE (no DELETE on any table; evv_event UPDATE is
--     narrowed to the two supersede columns by the immutability trigger). Destruction clears via the admin-run
--     eraseFn (evv_record class, M18-T07);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.6 PHI denylist
--     (GPS coordinate ciphers + free-text reason/auth-secret columns). Retention class 'compliance' (M18 §3.7
--     — `evv_record`, 7 years, the Medicaid EVV / HQRP survey-record artifact). All six carry organization_id,
--     so all six get BOTH an RLS policy and a trigger (arch:gaps phi-guards floor).--> statement-breakpoint
-- 1. `evv_event`: drop the plain table 0046 created, re-create RANGE-partitioned on event_at (§3.3/D12).--> statement-breakpoint
DROP TABLE IF EXISTS "evv_event" CASCADE;--> statement-breakpoint
CREATE TABLE "evv_event" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "visit_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "patient_address_id" uuid,
  "kind" "evv_event_kind" NOT NULL,
  "service_type_code" text NOT NULL,
  "posting_membership_id" uuid NOT NULL,
  "posting_discipline_at_recording" text NOT NULL,
  "evv_device_id" uuid NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "event_at" timestamp with time zone NOT NULL,
  "coords_cipher" text NOT NULL,
  "coords_dek_version" integer NOT NULL,
  "accuracy_m" real NOT NULL,
  "gps_quality" "evv_event_gps_quality" NOT NULL,
  "offline_capture" boolean DEFAULT false NOT NULL,
  "local_id" uuid,
  "synced_at" timestamp with time zone,
  "replaces_event_id" uuid,
  "superseded_at" timestamp with time zone,
  "superseded_by_event_id" uuid,
  "correction_reason" text,
  "device_attestation_id_at_record" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evv_event_id_event_at_pk" PRIMARY KEY("id","event_at"),
  CONSTRAINT "evv_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "evv_event_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "evv_event_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "evv_event_posting_membership_id_membership_id_fk" FOREIGN KEY ("posting_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict,
  CONSTRAINT "evv_event_evv_device_id_evv_device_id_fk" FOREIGN KEY ("evv_device_id") REFERENCES "public"."evv_device"("id") ON DELETE restrict
) PARTITION BY RANGE ("event_at");--> statement-breakpoint
-- Per-leaf partial-UNIQUE backstops (§3.2 Phase E): the D2 active-pair invariant (at most one active check_in
-- and one active check_out per visit) and the D5 offline idempotency key. Both omit the partition key, so they
-- cannot live on the partitioned parent and are added per leaf instead. A visit's check-in/check-out share an
-- event_at month, so per-partition enforcement is the race backstop; the app pairing lookup fires first.--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_evv_event_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id, visit_id, kind) WHERE superseded_by_event_id IS NULL',
    partition_name || '_active_visit_kind_uidx', partition_name
  );
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id, evv_device_id, local_id) WHERE local_id IS NOT NULL',
    partition_name || '_offline_idem_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_evv_event_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'evv_event_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF evv_event FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
  PERFORM add_evv_event_unique_indexes(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF evv_event DEFAULT', 'evv_event_default');
  PERFORM add_evv_event_unique_indexes('evv_event_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_evv_event_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "evv_event_org_visit_idx" ON "evv_event" USING btree ("organization_id","visit_id","kind");--> statement-breakpoint
CREATE INDEX "evv_event_org_patient_idx" ON "evv_event" USING btree ("organization_id","patient_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_membership_idx" ON "evv_event" USING btree ("organization_id","posting_membership_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_device_idx" ON "evv_event" USING btree ("organization_id","evv_device_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_gps_quality_idx" ON "evv_event" USING btree ("organization_id","gps_quality","event_at");--> statement-breakpoint
-- 2. §3.2 Phase C: append-only immutability trigger on evv_event. Only the supersede markers may change on
-- UPDATE; DELETE is refused entirely. Correction-of-record is an append (a NEW row with replaces_event_id).--> statement-breakpoint
CREATE OR REPLACE FUNCTION evv_event_enforce_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_NO_DELETE';
  END IF;
  IF (to_jsonb(NEW) - 'superseded_at' - 'superseded_by_event_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at' - 'superseded_by_event_id') THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "evv_event_append_only_trg"
  BEFORE UPDATE OR DELETE ON evv_event
  FOR EACH ROW EXECUTE FUNCTION evv_event_enforce_append_only();--> statement-breakpoint
-- 3. Org-scope RLS + grants (standard app.org_id; §3.5). No DELETE for wardenx_app.--> statement-breakpoint
ALTER TABLE "evv_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_event_org" ON "evv_event";
CREATE POLICY "evv_event_org" ON "evv_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_event" TO wardenx_app;
GRANT ALL ON "evv_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "evv_geofence_evaluation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_geofence_evaluation_org" ON "evv_geofence_evaluation";
CREATE POLICY "evv_geofence_evaluation_org" ON "evv_geofence_evaluation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_geofence_evaluation" TO wardenx_app;
GRANT ALL ON "evv_geofence_evaluation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "evv_geofence_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_geofence_policy_org" ON "evv_geofence_policy";
CREATE POLICY "evv_geofence_policy_org" ON "evv_geofence_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_geofence_policy" TO wardenx_app;
GRANT ALL ON "evv_geofence_policy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "evv_device" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_device_org" ON "evv_device";
CREATE POLICY "evv_device_org" ON "evv_device"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_device" TO wardenx_app;
GRANT ALL ON "evv_device" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "evv_missing_resolution" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_missing_resolution_org" ON "evv_missing_resolution";
CREATE POLICY "evv_missing_resolution_org" ON "evv_missing_resolution"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_missing_resolution" TO wardenx_app;
GRANT ALL ON "evv_missing_resolution" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "evv_aggregator_submission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "evv_aggregator_submission_org" ON "evv_aggregator_submission";
CREATE POLICY "evv_aggregator_submission_org" ON "evv_aggregator_submission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "evv_aggregator_submission" TO wardenx_app;
GRANT ALL ON "evv_aggregator_submission" TO wardenx_admin;--> statement-breakpoint
-- 4. M4 write-audit triggers (per-table PHI denylist, §3.6; retention 'compliance' / `evv_record` per §3.7).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['coords_cipher','accuracy_m','correction_reason']::text[];
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
    'evv_event.' || lower(TG_OP),
    'evv_event',
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
ALTER FUNCTION audit_phi_write_evv_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_event" AFTER INSERT OR UPDATE OR DELETE ON evv_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_geofence_evaluation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['patient_address_coords_cipher','device_coords_cipher']::text[];
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
    'system',
    'evv_geofence_evaluation.' || lower(TG_OP),
    'evv_geofence_evaluation',
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
ALTER FUNCTION audit_phi_write_evv_geofence_evaluation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_geofence_evaluation" AFTER INSERT OR UPDATE OR DELETE ON evv_geofence_evaluation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_geofence_evaluation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_geofence_policy() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['override_reason']::text[];
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
    'evv_geofence_policy.' || lower(TG_OP),
    'evv_geofence_policy',
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
ALTER FUNCTION audit_phi_write_evv_geofence_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_geofence_policy" AFTER INSERT OR UPDATE OR DELETE ON evv_geofence_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_geofence_policy();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_device() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['denial_reason','suspend_reason','device_key_fingerprint']::text[];
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
    'evv_device.' || lower(TG_OP),
    'evv_device',
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
ALTER FUNCTION audit_phi_write_evv_device() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_device" AFTER INSERT OR UPDATE OR DELETE ON evv_device
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_device();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_missing_resolution() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['resolution_reason']::text[];
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
    'evv_missing_resolution.' || lower(TG_OP),
    'evv_missing_resolution',
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
ALTER FUNCTION audit_phi_write_evv_missing_resolution() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_missing_resolution" AFTER INSERT OR UPDATE OR DELETE ON evv_missing_resolution
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_missing_resolution();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_evv_aggregator_submission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload_cipher','aggregator_response_cipher','aggregator_rejection_reason','cancellation_reason']::text[];
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
    'system',
    'evv_aggregator_submission.' || lower(TG_OP),
    'evv_aggregator_submission',
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
ALTER FUNCTION audit_phi_write_evv_aggregator_submission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_aggregator_submission" AFTER INSERT OR UPDATE OR DELETE ON evv_aggregator_submission
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_aggregator_submission();
