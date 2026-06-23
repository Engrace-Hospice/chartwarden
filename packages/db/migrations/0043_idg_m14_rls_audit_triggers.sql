-- M14 IDG §3.3/§3.4 (RLS + grants) + the idg_patient_packet PARTITION BY RANGE conversion + M4
-- write-audit triggers — M14-T02.
--
-- Tables/enums/indexes/FKs land in 0042 (drizzle-generated). This migration locks:
--   • the §3.3 / D12 PARTITION BY RANGE (built_at) conversion of idg_patient_packet — Postgres requires
--     PARTITION BY at CREATE time, so (administration_record precedent, 0041) we drop the plain table 0042
--     created and re-create it partitioned, with the same columns/PK/FKs/indexes. Monthly partitions
--     (current + 12 forward) + a DEFAULT catch-all, created dynamically via format(%I) so the static
--     phi-guards scan does not mis-detect a partition child as a separate un-triggered org table (row
--     triggers on the partitioned parent propagate to every partition, PG11+). The M1 partition-maintenance
--     cron rotates new months. The other eight M14 tables are non-partitioned (§3.3);
--   • standard app.org_id org-scope RLS on all nine M14 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()). The four patient-bearing tables (idg_agenda_item / idg_decision /
--     idg_action_item carry a nullable patient_id → nullable provider_entity_id + location_id; idg_patient_packet
--     carries them NOT NULL) keep the three-column tenancy for ABAC narrowing, but the RLS pivot is
--     organization_id alone (§3.3);
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (meetings/decisions/minutes
--     are append + status-transition; destruction clears via the admin-run eraseFn, M14-T07);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.3 PHI denylist.
--     idg_decision is special: narrative free-text lives INSIDE the per-kind `payload` jsonb (rationaleText /
--     noteText / narrative / recommendations / requestedOrders / mutations), so the trigger scrubs the (empty)
--     top-level column set then re-scrubs the `payload` object's denylisted keys. idg_patient_packet scrubs
--     top-level cover summaries + the discipline_views column, then re-scrubs the `built_snapshot` object's
--     denylisted keys (discipline_views / sinceLastIdg). The other tables denylist only top-level free-text:
--     idg_attendance (absence_note); idg_agenda_item (body_text); idg_action_item (body_text); idg_minutes
--     (closing_note); idg_minutes_amendment (amendment_reason). idg_recurring_policy / idg_meeting carry
--     structural-only fields (empty denylist). All nine carry organization_id, so all nine get BOTH an RLS
--     policy and a trigger (arch:gaps phi-guards floor). Retention class 'compliance' (CoP §418.56 IDG
--     records, M4 D1).--> statement-breakpoint
-- 1. idg_patient_packet: drop the plain table 0042 created, re-create RANGE-partitioned on built_at (§3.3).
--    Same logical shape as the Drizzle definition; the partition + monthly children are invisible to
--    drizzle-kit (it diffs the 0042 snapshot, which carries the logical table). Cross-module + intra-module
--    refs to the partitioned table stay plain uuid (NO SQL FK, §3.3); only org/PE/location carry FKs.--> statement-breakpoint
DROP TABLE IF EXISTS "idg_patient_packet" CASCADE;--> statement-breakpoint
CREATE TABLE "idg_patient_packet" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "idg_meeting_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "built_at" timestamp with time zone DEFAULT now() NOT NULL,
  "frozen_at" timestamp with time zone,
  "last_idg_reviewed_at" timestamp with time zone,
  "since_cursor_iso" text NOT NULL,
  "built_snapshot" jsonb NOT NULL,
  "discipline_views" jsonb NOT NULL,
  "cover_summary_layer1" text NOT NULL,
  "cover_summary_layer2" text,
  "packet_document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idg_patient_packet_id_built_at_pk" PRIMARY KEY("id","built_at"),
  CONSTRAINT "idg_patient_packet_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "idg_patient_packet_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "idg_patient_packet_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
) PARTITION BY RANGE ("built_at");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF idg_patient_packet DEFAULT', 'idg_patient_packet_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_idg_patient_packet_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'idg_patient_packet_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF idg_patient_packet FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_idg_patient_packet_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "idg_patient_packet_meeting_patient_idx" ON "idg_patient_packet" USING btree ("organization_id","idg_meeting_id","patient_id");--> statement-breakpoint
CREATE INDEX "idg_patient_packet_admission_reviewed_idx" ON "idg_patient_packet" USING btree ("organization_id","admission_id","last_idg_reviewed_at" DESC NULLS LAST);--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.3). No DELETE — append + status-transition.--> statement-breakpoint
ALTER TABLE "idg_recurring_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_recurring_policy_org" ON "idg_recurring_policy";
CREATE POLICY "idg_recurring_policy_org" ON "idg_recurring_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_recurring_policy" TO wardenx_app;
GRANT ALL ON "idg_recurring_policy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_meeting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_meeting_org" ON "idg_meeting";
CREATE POLICY "idg_meeting_org" ON "idg_meeting"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_meeting" TO wardenx_app;
GRANT ALL ON "idg_meeting" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_attendance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_attendance_org" ON "idg_attendance";
CREATE POLICY "idg_attendance_org" ON "idg_attendance"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_attendance" TO wardenx_app;
GRANT ALL ON "idg_attendance" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_agenda_item" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_agenda_item_org" ON "idg_agenda_item";
CREATE POLICY "idg_agenda_item_org" ON "idg_agenda_item"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_agenda_item" TO wardenx_app;
GRANT ALL ON "idg_agenda_item" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_decision" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_decision_org" ON "idg_decision";
CREATE POLICY "idg_decision_org" ON "idg_decision"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_decision" TO wardenx_app;
GRANT ALL ON "idg_decision" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_action_item" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_action_item_org" ON "idg_action_item";
CREATE POLICY "idg_action_item_org" ON "idg_action_item"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_action_item" TO wardenx_app;
GRANT ALL ON "idg_action_item" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_minutes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_minutes_org" ON "idg_minutes";
CREATE POLICY "idg_minutes_org" ON "idg_minutes"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_minutes" TO wardenx_app;
GRANT ALL ON "idg_minutes" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_minutes_amendment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_minutes_amendment_org" ON "idg_minutes_amendment";
CREATE POLICY "idg_minutes_amendment_org" ON "idg_minutes_amendment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_minutes_amendment" TO wardenx_app;
GRANT ALL ON "idg_minutes_amendment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "idg_patient_packet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idg_patient_packet_org" ON "idg_patient_packet";
CREATE POLICY "idg_patient_packet_org" ON "idg_patient_packet"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "idg_patient_packet" TO wardenx_app;
GRANT ALL ON "idg_patient_packet" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, §3.3). audit_scrub keys on top-level columns;
--    idg_decision additionally re-scrubs the nested `payload` keys, idg_patient_packet the `built_snapshot` keys.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_recurring_policy() RETURNS trigger
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
    'idg_recurring_policy.' || lower(TG_OP),
    'idg_recurring_policy',
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
ALTER FUNCTION audit_phi_write_idg_recurring_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_recurring_policy" AFTER INSERT OR UPDATE OR DELETE ON idg_recurring_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_recurring_policy();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_meeting() RETURNS trigger
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
    'idg_meeting.' || lower(TG_OP),
    'idg_meeting',
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
ALTER FUNCTION audit_phi_write_idg_meeting() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_meeting" AFTER INSERT OR UPDATE OR DELETE ON idg_meeting
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_meeting();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_attendance() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['absence_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['absence_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_attendance.' || lower(TG_OP),
    'idg_attendance',
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
ALTER FUNCTION audit_phi_write_idg_attendance() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_attendance" AFTER INSERT OR UPDATE OR DELETE ON idg_attendance
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_attendance();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_agenda_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_agenda_item.' || lower(TG_OP),
    'idg_agenda_item',
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
ALTER FUNCTION audit_phi_write_idg_agenda_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_agenda_item" AFTER INSERT OR UPDATE OR DELETE ON idg_agenda_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_agenda_item();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_decision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_payload_keys text[] := ARRAY['rationaleText','noteText','narrative','recommendations',
    'requestedOrders','mutations']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY[]::text[]);
    IF v_before ? 'payload' AND jsonb_typeof(v_before->'payload') = 'object' THEN
      v_before := jsonb_set(v_before, '{payload}', audit_scrub(v_before->'payload', v_payload_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), ARRAY[]::text[]);
    IF v_after ? 'payload' AND jsonb_typeof(v_after->'payload') = 'object' THEN
      v_after := jsonb_set(v_after, '{payload}', audit_scrub(v_after->'payload', v_payload_keys));
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
    'idg_decision.' || lower(TG_OP),
    'idg_decision',
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
ALTER FUNCTION audit_phi_write_idg_decision() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_decision" AFTER INSERT OR UPDATE OR DELETE ON idg_decision
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_decision();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_action_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_action_item.' || lower(TG_OP),
    'idg_action_item',
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
ALTER FUNCTION audit_phi_write_idg_action_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_action_item" AFTER INSERT OR UPDATE OR DELETE ON idg_action_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_action_item();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_minutes() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['closing_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['closing_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_minutes.' || lower(TG_OP),
    'idg_minutes',
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
ALTER FUNCTION audit_phi_write_idg_minutes() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_minutes" AFTER INSERT OR UPDATE OR DELETE ON idg_minutes
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_minutes();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_minutes_amendment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['amendment_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['amendment_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_minutes_amendment.' || lower(TG_OP),
    'idg_minutes_amendment',
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
ALTER FUNCTION audit_phi_write_idg_minutes_amendment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_minutes_amendment" AFTER INSERT OR UPDATE OR DELETE ON idg_minutes_amendment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_minutes_amendment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_idg_patient_packet() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['cover_summary_layer1','cover_summary_layer2','discipline_views']::text[];
  v_snapshot_keys text[] := ARRAY['discipline_views','sinceLastIdg']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), v_cols);
    IF v_before ? 'built_snapshot' AND jsonb_typeof(v_before->'built_snapshot') = 'object' THEN
      v_before := jsonb_set(v_before, '{built_snapshot}', audit_scrub(v_before->'built_snapshot', v_snapshot_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), v_cols);
    IF v_after ? 'built_snapshot' AND jsonb_typeof(v_after->'built_snapshot') = 'object' THEN
      v_after := jsonb_set(v_after, '{built_snapshot}', audit_scrub(v_after->'built_snapshot', v_snapshot_keys));
    END IF;
  END IF;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'idg_patient_packet.' || lower(TG_OP),
    'idg_patient_packet',
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
ALTER FUNCTION audit_phi_write_idg_patient_packet() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_patient_packet" AFTER INSERT OR UPDATE OR DELETE ON idg_patient_packet
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_patient_packet();
