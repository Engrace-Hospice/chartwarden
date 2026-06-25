-- M33 Reporting & Dashboards §3.2 (phase 8) / §3.6 — write-audit triggers (consumes the M4 generator).
-- Mirrors 0053 (M34) exactly. Two families:
--
--   (a) audit_phi_write_<table>() — canonical M4 generateAuditTrigger() output: SECURITY DEFINER,
--       OWNER TO wardenx_audit_writer, column-level audit_scrub denylist, org context keyed on
--       COALESCE(NEW.organization_id, OLD.organization_id). Applied to every ORG-SCOPED M33 table so the
--       phi-guards floor (every org-scoped table carries BOTH an RLS policy AND a write-audit trigger) is
--       satisfied: report_definition, report_definition_version, report_view, report_share,
--       report_schedule, report_schedule_run, report_run, dashboard_tile_cache, report_drilldown_audit.
--       retentionClass = 'compliance' for all. report_run's organization_id may be NULL (platform-wide
--       refresh) — audit_event.organization_id is nullable, so the COALESCE is null-safe.
--       §3.6 field-level denylists: report_schedule.recipient_membership_ids (surveyor-mode privacy) and
--       report_drilldown_audit.query_filters_cipher (envelope-encrypted; emit <changed> marker only).
--
--   (b) the M1 null-safe baseline wardenx_audit_trigger() — applied to the three genuinely org-less
--       PLATFORM catalogs (materialized_view_metadata, report_base_catalog, report_metric_catalog), the
--       same posture as the M34 onboarding_task_template / M38 platform tables.
--
-- NB: the *_run / drilldown tables are RANGE-partitioned (0057). A FOR EACH ROW trigger on a partitioned
-- parent propagates to every partition automatically; OLD/NEW bind to the routed leaf, so family (a)
-- works unchanged. CREATE TRIGGER uses the UNQUOTED table name (phi-guards trigger regex requirement).

-- ============================================================================================
-- (a) organization_id-bearing tables — canonical M4 generateAuditTrigger() output.
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_report_definition() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_definition.' || lower(TG_OP), 'report_definition',
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
ALTER FUNCTION audit_phi_write_report_definition() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_definition" AFTER INSERT OR UPDATE OR DELETE ON report_definition
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_definition();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_report_definition_version() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_definition_version.' || lower(TG_OP), 'report_definition_version',
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
ALTER FUNCTION audit_phi_write_report_definition_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_definition_version" AFTER INSERT OR UPDATE OR DELETE ON report_definition_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_definition_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_report_view() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_view.' || lower(TG_OP), 'report_view',
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
ALTER FUNCTION audit_phi_write_report_view() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_view" AFTER INSERT OR UPDATE OR DELETE ON report_view
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_view();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_report_share() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_share.' || lower(TG_OP), 'report_share',
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
ALTER FUNCTION audit_phi_write_report_share() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_share" AFTER INSERT OR UPDATE OR DELETE ON report_share
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_share();--> statement-breakpoint

-- report_schedule — §3.6 denylist: recipient_membership_ids (surveyor-mode privacy).
CREATE OR REPLACE FUNCTION audit_phi_write_report_schedule() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['recipient_membership_ids']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_schedule.' || lower(TG_OP), 'report_schedule',
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
ALTER FUNCTION audit_phi_write_report_schedule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_schedule" AFTER INSERT OR UPDATE OR DELETE ON report_schedule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_schedule();--> statement-breakpoint

-- report_schedule_run — system-written run ledger (partitioned parent).
CREATE OR REPLACE FUNCTION audit_phi_write_report_schedule_run() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'report_schedule_run.' || lower(TG_OP), 'report_schedule_run',
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
ALTER FUNCTION audit_phi_write_report_schedule_run() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_schedule_run" AFTER INSERT OR UPDATE OR DELETE ON report_schedule_run
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_schedule_run();--> statement-breakpoint

-- report_run — system-written MV-refresh ledger (partitioned parent; organization_id may be NULL).
CREATE OR REPLACE FUNCTION audit_phi_write_report_run() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'report_run.' || lower(TG_OP), 'report_run',
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
ALTER FUNCTION audit_phi_write_report_run() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_run" AFTER INSERT OR UPDATE OR DELETE ON report_run
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_run();--> statement-breakpoint

-- dashboard_tile_cache — system-written transient cache.
CREATE OR REPLACE FUNCTION audit_phi_write_dashboard_tile_cache() RETURNS trigger
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
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system', 'dashboard_tile_cache.' || lower(TG_OP), 'dashboard_tile_cache',
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
ALTER FUNCTION audit_phi_write_dashboard_tile_cache() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dashboard_tile_cache" AFTER INSERT OR UPDATE OR DELETE ON dashboard_tile_cache
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dashboard_tile_cache();--> statement-breakpoint

-- report_drilldown_audit — §3.6 denylist: query_filters_cipher (envelope-encrypted; <changed> marker
-- only). Insert-only ledger (partitioned parent).
CREATE OR REPLACE FUNCTION audit_phi_write_report_drilldown_audit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['query_filters_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'report_drilldown_audit.' || lower(TG_OP), 'report_drilldown_audit',
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
ALTER FUNCTION audit_phi_write_report_drilldown_audit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_report_drilldown_audit" AFTER INSERT OR UPDATE OR DELETE ON report_drilldown_audit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_report_drilldown_audit();--> statement-breakpoint

-- ============================================================================================
-- (b) genuinely org-less PLATFORM catalogs — M1 null-safe baseline wardenx_audit_trigger().
-- ============================================================================================
CREATE TRIGGER "materialized_view_metadata_audit" AFTER INSERT OR UPDATE OR DELETE ON materialized_view_metadata
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "report_base_catalog_audit" AFTER INSERT OR UPDATE OR DELETE ON report_base_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "report_metric_catalog_audit" AFTER INSERT OR UPDATE OR DELETE ON report_metric_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
