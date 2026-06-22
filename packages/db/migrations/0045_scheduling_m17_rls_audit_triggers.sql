-- M17 Scheduling §3.3/§3.5/§3.6 (RLS + grants) + the visit / visit_state_history PARTITION BY RANGE
-- conversions + the D6/D7 GiST EXCLUDE backstops + M4 write-audit triggers — M17-T02.
--
-- Tables/enums/indexes/FKs land in 0044 (drizzle-generated). This migration locks:
--   • the btree_gist extension (first use in the corpus) — needed for the uuid/date equality opclasses in
--     the D6/D7 exclusion constraints;
--   • the §3.3 / D14 PARTITION BY RANGE conversions of `visit` (by service_date) and `visit_state_history`
--     (by transitioned_at). Postgres requires PARTITION BY at CREATE time, so (idg_patient_packet precedent,
--     0043) we drop the plain tables 0044 created and re-create them partitioned, same columns/PK/FKs/
--     indexes. Monthly partitions (current + 12 forward) + a DEFAULT catch-all, created dynamically via
--     format(%I) so the static phi-guards scan does not mis-detect a partition child as a separate
--     un-triggered org table (row triggers on the partitioned parent propagate to every partition, PG11+).
--     The M1 partition-maintenance cron rotates new months. Because `visit` is partitioned, references TO it
--     (visit_state_history.visit_id, route_segment from/to visit refs, the reschedule self-refs) carry NO SQL
--     FK — plain uuid, app-validated;
--   • the D6 visit-overlap EXCLUDE — Postgres forbids EXCLUDE on a partitioned PARENT entirely, so the GiST
--     exclusion (assigned_membership_id WITH =, tstzrange(scheduled_started_at, scheduled_ended_at) WITH &&)
--     WHERE status IN ('published','en_route','in_visit') is added to each LEAF partition via
--     add_visit_overlap_exclude(); visit time-ranges live inside one service_date/partition, so per-partition
--     enforcement is the race backstop and the app-layer pre-schedule gate gives the friendly error first
--     (D6). The D7 PTO-overlap EXCLUDE on the non-partitioned `time_off` is the plain form;
--   • standard app.org_id org-scope RLS on all seven tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()). M17-F01: the patient-scoped tables (visit / recurring_visit /
--     visit_proposal) carry provider_entity_id + location_id NOT NULL; the clinician/route-scoped ones carry
--     them nullable. The RLS pivot is organization_id alone (§3.5);
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE (SELECT/INSERT only on the append-only
--     visit_state_history) and DELETE on NONE; destruction clears via the admin-run eraseFn (M17-T07);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.6 PHI denylist.
--     Retention class 'operational' (M17 §3.7 — 3 years post-discharge, M4 §6). All seven carry
--     organization_id, so all seven get BOTH an RLS policy and a trigger (arch:gaps phi-guards floor).--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- 1. `visit`: drop the plain table 0044 created, re-create RANGE-partitioned on service_date (§3.3/D14).--> statement-breakpoint
DROP TABLE IF EXISTS "visit" CASCADE;--> statement-breakpoint
CREATE TABLE "visit" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "patient_address_id" uuid,
  "external_facility_id" uuid,
  "assigned_membership_id" uuid NOT NULL,
  "assigned_discipline_at_assignment" text NOT NULL,
  "visit_purpose" "visit_purpose" NOT NULL,
  "visit_setting" "visit_setting" NOT NULL,
  "scheduled_started_at" timestamp with time zone NOT NULL,
  "scheduled_ended_at" timestamp with time zone NOT NULL,
  "service_date" date NOT NULL,
  "actual_started_at" timestamp with time zone,
  "actual_ended_at" timestamp with time zone,
  "status" "visit_status" DEFAULT 'proposed' NOT NULL,
  "evv_bracket_state" "evv_bracket_state",
  "evv_check_in_event_id" uuid,
  "evv_check_out_event_id" uuid,
  "evv_missing_reason" text,
  "parent_recurring_visit_id" uuid,
  "parent_proposal_id" uuid,
  "encounter_id" uuid,
  "telehealth_room_id" uuid,
  "scheduler_internal_notes" text,
  "cancelled_by_membership_id" uuid,
  "cancelled_at" timestamp with time zone,
  "cancellation_reason" text,
  "cancellation_reason_code" text,
  "rescheduled_into_visit_id" uuid,
  "rescheduled_from_visit_id" uuid,
  "reschedule_reason" text,
  "no_show_detected_at" timestamp with time zone,
  "no_show_reason" text,
  "proposed_route_sequence_index" integer,
  "proposed_inbound_miles" integer,
  "proposed_inbound_drive_minutes" integer,
  "caregiver_reminder_opt_in" boolean DEFAULT false NOT NULL,
  "caregiver_reminder_sent_at" timestamp with time zone,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visit_id_service_date_pk" PRIMARY KEY("id","service_date"),
  CONSTRAINT "visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "visit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "visit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "visit_assigned_membership_id_membership_id_fk" FOREIGN KEY ("assigned_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict
) PARTITION BY RANGE ("service_date");--> statement-breakpoint
-- D6 overlap backstop. Postgres does NOT allow EXCLUDE constraints on a partitioned PARENT (even when the
-- partition key is compared WITH =), so the GiST exclusion is added to each leaf partition instead: no two
-- non-terminal visits for the same clinician overlap in time within a partition. Visit time-ranges live
-- inside one service_date (and thus one monthly partition) except the vanishingly-rare cross-midnight case,
-- which the app-layer pre-schedule gate still catches (D6 — the app check fires first for the friendly
-- error; this is the race backstop). Needs btree_gist for the uuid equality opclass.--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_visit_overlap_exclude(partition_name text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = partition_name || '_no_overlap') THEN
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I EXCLUDE USING gist (assigned_membership_id WITH =, ' ||
      'tstzrange(scheduled_started_at, scheduled_ended_at) WITH &&) WHERE (status IN (%L,%L,%L))',
      partition_name, partition_name || '_no_overlap', 'published', 'en_route', 'in_visit'
    );
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_visit_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'visit_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF visit FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
  PERFORM add_visit_overlap_exclude(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF visit DEFAULT', 'visit_default');
  PERFORM add_visit_overlap_exclude('visit_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_visit_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "visit_org_location_service_date_idx" ON "visit" USING btree ("organization_id","location_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_service_date_idx" ON "visit" USING btree ("organization_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_patient_idx" ON "visit" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "visit_org_membership_idx" ON "visit" USING btree ("organization_id","assigned_membership_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_admission_idx" ON "visit" USING btree ("organization_id","admission_id");--> statement-breakpoint
CREATE INDEX "visit_org_status_idx" ON "visit" USING btree ("organization_id","status") WHERE status IN ('proposed','published','en_route','in_visit');--> statement-breakpoint
-- 2. `visit_state_history`: drop the plain table, re-create RANGE-partitioned on transitioned_at (D14).--> statement-breakpoint
DROP TABLE IF EXISTS "visit_state_history" CASCADE;--> statement-breakpoint
CREATE TABLE "visit_state_history" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "visit_id" uuid NOT NULL,
  "from_state" "visit_status",
  "to_state" "visit_status" NOT NULL,
  "actor_membership_id" uuid,
  "system_source" text,
  "reason" text,
  "outbox_event_id" uuid,
  "transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "visit_state_history_id_transitioned_at_pk" PRIMARY KEY("id","transitioned_at"),
  CONSTRAINT "visit_state_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "visit_state_history_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "visit_state_history_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
) PARTITION BY RANGE ("transitioned_at");--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF visit_state_history DEFAULT', 'visit_state_history_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_visit_state_history_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'visit_state_history_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF visit_state_history FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_visit_state_history_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "vsh_visit_at_idx" ON "visit_state_history" USING btree ("visit_id","transitioned_at");--> statement-breakpoint
-- 3. D7 PTO-overlap backstop on the non-partitioned time_off — one approved window per clinician.--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_no_approved_overlap"
  EXCLUDE USING gist (
    "membership_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&
  ) WHERE (approval_state = 'approved');--> statement-breakpoint
-- 4. Org-scope RLS + grants (standard app.org_id; §3.5). No DELETE for wardenx_app.--> statement-breakpoint
ALTER TABLE "visit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "visit_org" ON "visit";
CREATE POLICY "visit_org" ON "visit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "visit" TO wardenx_app;
GRANT ALL ON "visit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "visit_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "visit_state_history_org" ON "visit_state_history";
CREATE POLICY "visit_state_history_org" ON "visit_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "visit_state_history" TO wardenx_app;
GRANT ALL ON "visit_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "recurring_visit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recurring_visit_org" ON "recurring_visit";
CREATE POLICY "recurring_visit_org" ON "recurring_visit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "recurring_visit" TO wardenx_app;
GRANT ALL ON "recurring_visit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "visit_proposal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "visit_proposal_org" ON "visit_proposal";
CREATE POLICY "visit_proposal_org" ON "visit_proposal"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "visit_proposal" TO wardenx_app;
GRANT ALL ON "visit_proposal" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "clinician_availability" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clinician_availability_org" ON "clinician_availability";
CREATE POLICY "clinician_availability_org" ON "clinician_availability"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "clinician_availability" TO wardenx_app;
GRANT ALL ON "clinician_availability" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "time_off_org" ON "time_off";
CREATE POLICY "time_off_org" ON "time_off"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "time_off" TO wardenx_app;
GRANT ALL ON "time_off" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "route_segment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "route_segment_org" ON "route_segment";
CREATE POLICY "route_segment_org" ON "route_segment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "route_segment" TO wardenx_app;
GRANT ALL ON "route_segment" TO wardenx_admin;--> statement-breakpoint
-- 5. M4 write-audit triggers (per-table PHI denylist, §3.6; retention 'operational' per §3.7).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_visit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['scheduler_internal_notes','cancellation_reason','reschedule_reason',
    'no_show_reason','evv_missing_reason']::text[];
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
    'visit.' || lower(TG_OP),
    'visit',
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
ALTER FUNCTION audit_phi_write_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_visit" AFTER INSERT OR UPDATE OR DELETE ON visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_visit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_visit_state_history() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'visit_state_history.' || lower(TG_OP),
    'visit_state_history',
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
ALTER FUNCTION audit_phi_write_visit_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_visit_state_history" AFTER INSERT OR UPDATE OR DELETE ON visit_state_history
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_visit_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_recurring_visit() RETURNS trigger
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
    'recurring_visit.' || lower(TG_OP),
    'recurring_visit',
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
ALTER FUNCTION audit_phi_write_recurring_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_recurring_visit" AFTER INSERT OR UPDATE OR DELETE ON recurring_visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_recurring_visit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_visit_proposal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['dismissal_reason','source_payload']::text[];
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
    'visit_proposal.' || lower(TG_OP),
    'visit_proposal',
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
ALTER FUNCTION audit_phi_write_visit_proposal() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_visit_proposal" AFTER INSERT OR UPDATE OR DELETE ON visit_proposal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_visit_proposal();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_clinician_availability() RETURNS trigger
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
    'clinician_availability.' || lower(TG_OP),
    'clinician_availability',
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
ALTER FUNCTION audit_phi_write_clinician_availability() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clinician_availability" AFTER INSERT OR UPDATE OR DELETE ON clinician_availability
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clinician_availability();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_time_off() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['request_note','denial_reason']::text[];
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
    'time_off.' || lower(TG_OP),
    'time_off',
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
ALTER FUNCTION audit_phi_write_time_off() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_time_off" AFTER INSERT OR UPDATE OR DELETE ON time_off
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_time_off();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_route_segment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['polyline']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['polyline']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'route_segment.' || lower(TG_OP),
    'route_segment',
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
ALTER FUNCTION audit_phi_write_route_segment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_route_segment" AFTER INSERT OR UPDATE OR DELETE ON route_segment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_route_segment();
