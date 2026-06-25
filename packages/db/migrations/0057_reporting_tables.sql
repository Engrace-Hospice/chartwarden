-- M33 Reporting & Dashboards §3.2 (phases 2–6) / §3.3–§3.4 — the 12 M33-owned tables, their FKs,
-- the monthly RANGE partition parents (report_schedule_run / report_run / report_drilldown_audit),
-- and the §3.4 critical indexes (M33-T02). Hand-written SQL mirroring the
-- packages/db/src/schema/reporting/*.ts Drizzle definitions. RLS + grants land in 0058; the M4
-- write-audit triggers in 0059; the report_mv materialized views + wrapper functions in 0060; the
-- platform catalog/MV-metadata seed in 0061.
--
-- Status/kind columns are Drizzle `text(..,{enum})` — TS-level enums, plain `text` in the DB (no
-- CREATE TYPE), so this migration creates NO Postgres enum types (unlike M34).
--
-- Three tables are PLATFORM-global catalogs with NO organization_id (retention class `platform`):
-- materialized_view_metadata, report_base_catalog, report_metric_catalog (read-all RLS in 0058; they
-- sit on the check-tenancy NON_ORG_SCOPED allowlist). The other nine carry organization_id and use
-- the canonical app.org_id RLS (report_run's organization_id is NULLABLE — cross-tenant platform-wide
-- refreshes carry no org; the canonical predicate hides those NULL-org rows from tenants by design).
--
-- The three partitioned tables are PARTITION BY RANGE on their time key (the EVV `0047` precedent):
-- only the empty parent + a DEFAULT catch-all + the current..+12 monthly children are created here; the
-- M1 partition-maintenance cron rotates new months. Their PK includes the partition key
-- (check-ddl-legality Rule 1). report_drilldown_audit's (drilldown_trace_id) UNIQUE omits the partition
-- key, so it is added PER LEAF via add_report_drilldown_audit_unique_indexes(); report_schedule_run's
-- (schedule_id, scheduled_for) UNIQUE includes the partition key, so it lives on the parent.

-- ============================================================================================
-- 1. PLATFORM catalogs (no organization_id). FK targets carry inline UNIQUE constraints.
-- ============================================================================================
CREATE TABLE "materialized_view_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mv_key" text NOT NULL,
	"schema_name" text DEFAULT 'report_mv' NOT NULL,
	"refresh_strategy" text NOT NULL,
	"debounce_window_seconds" integer DEFAULT 5 NOT NULL,
	"depends_on_mv_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outbox_topics_subscribed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_freshness_seconds" integer NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_refresh_duration_ms" integer,
	"refresh_failure_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "materialized_view_metadata_mv_key_unique" UNIQUE("mv_key")
);
--> statement-breakpoint
CREATE TABLE "report_base_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_key" text NOT NULL,
	"display_name" text NOT NULL,
	"domain" text NOT NULL,
	"description" text NOT NULL,
	"mv_key" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"measures" jsonb NOT NULL,
	"max_row_limit" integer DEFAULT 10000 NOT NULL,
	"drilldown_url_template" text,
	"exposes_phi_via_drilldown" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'seeded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deprecated_at" timestamp with time zone,
	CONSTRAINT "report_base_catalog_base_key_unique" UNIQUE("base_key")
);
--> statement-breakpoint
CREATE TABLE "report_metric_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_key" text NOT NULL,
	"display_name" text NOT NULL,
	"unit" text NOT NULL,
	"aggregation" text NOT NULL,
	"source_seam" text NOT NULL,
	"formula" text,
	"sensitive_flag" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'seeded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_metric_catalog_metric_key_unique" UNIQUE("metric_key")
);
--> statement-breakpoint
-- ============================================================================================
-- 2. Definition chain (org-scoped).
-- ============================================================================================
CREATE TABLE "report_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"authorship" text NOT NULL,
	"base_key" text NOT NULL,
	"owner_membership_id" uuid,
	"display_name" text NOT NULL,
	"description" text,
	"latest_version_id" uuid,
	"version_seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_definition_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_membership_id" uuid,
	"superseded_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid
);
--> statement-breakpoint
-- ============================================================================================
-- 3. Saved-surface tables (org-scoped).
-- ============================================================================================
CREATE TABLE "report_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"pinned_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"share_scope" text DEFAULT 'private' NOT NULL,
	"share_role_keys" jsonb,
	"is_org_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_view_id" uuid NOT NULL,
	"shared_with_membership_id" uuid,
	"shared_with_role_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_view_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"cron_expression" text NOT NULL,
	"tenant_timezone" text NOT NULL,
	"format" text NOT NULL,
	"recipient_membership_ids" jsonb NOT NULL,
	"delivery_channel" text DEFAULT 'in_app' NOT NULL,
	"next_run_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
-- ============================================================================================
-- 4. Run-history (partitioned) — report_schedule_run PARTITION BY RANGE (scheduled_for).
--    Composite PK (id, scheduled_for) includes the partition key. The (schedule_id, scheduled_for)
--    idempotency UNIQUE includes the partition key, so it lives on the parent (0058 §3.4 index).
-- ============================================================================================
CREATE TABLE "report_schedule_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"document_id" uuid,
	"failure_reason" text,
	"row_count" integer,
	CONSTRAINT "report_schedule_run_id_scheduled_for_pk" PRIMARY KEY("id","scheduled_for")
) PARTITION BY RANGE ("scheduled_for");
--> statement-breakpoint
-- report_run PARTITION BY RANGE (started_at). organization_id is NULLABLE (cross-tenant platform-wide
-- refreshes carry no org). Composite PK (id, started_at) includes the partition key.
CREATE TABLE "report_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"mv_key" text NOT NULL,
	"organization_id" uuid,
	"trigger_kind" text NOT NULL,
	"trigger_outbox_event_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"rows_affected" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"retry_attempt" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "report_run_id_started_at_pk" PRIMARY KEY("id","started_at")
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
-- ============================================================================================
-- 5. Cache (non-partitioned, transient TTL).
-- ============================================================================================
CREATE TABLE "dashboard_tile_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"freshness_seconds_at_compute" integer NOT NULL
);
--> statement-breakpoint
-- ============================================================================================
-- 6. report_drilldown_audit (partitioned, insert-only) — PARTITION BY RANGE (accessed_at).
--    Composite PK (id, accessed_at). query_filters_cipher is DENYLISTED in the M4 trigger (0059).
-- ============================================================================================
CREATE TABLE "report_drilldown_audit" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"report_view_id" uuid,
	"source_tile_key" text NOT NULL,
	"drilldown_target_module" integer NOT NULL,
	"drilldown_target_surface" text NOT NULL,
	"query_filters_cipher" text NOT NULL,
	"drilldown_trace_id" uuid NOT NULL,
	"is_consent_narrowed" boolean DEFAULT false NOT NULL,
	"consent_narrowing_reason" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_drilldown_audit_id_accessed_at_pk" PRIMARY KEY("id","accessed_at")
) PARTITION BY RANGE ("accessed_at");
--> statement-breakpoint

-- ============================================================================================
-- 7. Foreign keys — intra-M33 parents + the M2 org-spine (the cross-module membership/document refs
--    stay plain uuid app-validated, per the reporting schema convention).
-- ============================================================================================
ALTER TABLE "report_base_catalog" ADD CONSTRAINT "report_base_catalog_mv_key_materialized_view_metadata_mv_key_fk" FOREIGN KEY ("mv_key") REFERENCES "public"."materialized_view_metadata"("mv_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definition" ADD CONSTRAINT "report_definition_base_key_report_base_catalog_base_key_fk" FOREIGN KEY ("base_key") REFERENCES "public"."report_base_catalog"("base_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definition" ADD CONSTRAINT "report_definition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definition_version" ADD CONSTRAINT "report_definition_version_definition_id_report_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."report_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definition_version" ADD CONSTRAINT "report_definition_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_view" ADD CONSTRAINT "report_view_definition_version_id_report_definition_version_id_fk" FOREIGN KEY ("definition_version_id") REFERENCES "public"."report_definition_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_view" ADD CONSTRAINT "report_view_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_report_view_id_report_view_id_fk" FOREIGN KEY ("report_view_id") REFERENCES "public"."report_view"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_share" ADD CONSTRAINT "report_share_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule" ADD CONSTRAINT "report_schedule_report_view_id_report_view_id_fk" FOREIGN KEY ("report_view_id") REFERENCES "public"."report_view"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule" ADD CONSTRAINT "report_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_run" ADD CONSTRAINT "report_schedule_run_schedule_id_report_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedule"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_run" ADD CONSTRAINT "report_schedule_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_run" ADD CONSTRAINT "report_run_mv_key_materialized_view_metadata_mv_key_fk" FOREIGN KEY ("mv_key") REFERENCES "public"."materialized_view_metadata"("mv_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_run" ADD CONSTRAINT "report_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_tile_cache" ADD CONSTRAINT "dashboard_tile_cache_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_drilldown_audit" ADD CONSTRAINT "report_drilldown_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ============================================================================================
-- 8. Partition helpers + initial children (DEFAULT + current..+12 months) for the three partitioned
--    tables (the EVV `0047` precedent). Names built via format(%I) so the static phi-guards scan does
--    not mis-detect a partition child as a separate un-triggered org table (a FOR EACH ROW trigger on
--    the partitioned parent propagates to every partition, PG11+).
-- ============================================================================================
-- 8a. report_schedule_run — no per-leaf UNIQUE needed (the idempotency UNIQUE includes the partition
--     key and lives on the parent, §11 below).
CREATE OR REPLACE FUNCTION create_report_schedule_run_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'report_schedule_run_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF report_schedule_run FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF report_schedule_run DEFAULT', 'report_schedule_run_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_report_schedule_run_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
-- 8b. report_run — no per-leaf UNIQUE needed.
CREATE OR REPLACE FUNCTION create_report_run_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'report_run_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF report_run FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF report_run DEFAULT', 'report_run_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_report_run_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
-- 8c. report_drilldown_audit — per-leaf (drilldown_trace_id) UNIQUE (omits the partition key, so it
--     cannot live on the partitioned parent; added per leaf like the EVV per-leaf backstops).
CREATE OR REPLACE FUNCTION add_report_drilldown_audit_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (drilldown_trace_id)',
    partition_name || '_trace_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_report_drilldown_audit_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'report_drilldown_audit_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF report_drilldown_audit FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
  PERFORM add_report_drilldown_audit_unique_indexes(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF report_drilldown_audit DEFAULT', 'report_drilldown_audit_default');
  PERFORM add_report_drilldown_audit_unique_indexes('report_drilldown_audit_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_report_drilldown_audit_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint

-- ============================================================================================
-- 9. §3.4 critical indexes (beyond PKs and the partition keys). Indexes created on a partitioned
--    parent propagate to every partition automatically.
-- ============================================================================================
CREATE INDEX "report_definition_org_status_authorship_idx" ON "report_definition" USING btree ("organization_id","status","authorship");--> statement-breakpoint
CREATE INDEX "report_definition_base_status_idx" ON "report_definition" USING btree ("base_key","status");--> statement-breakpoint
CREATE INDEX "report_definition_version_def_version_idx" ON "report_definition_version" USING btree ("definition_id","version_number" DESC);--> statement-breakpoint
CREATE INDEX "report_definition_version_org_published_idx" ON "report_definition_version" USING btree ("organization_id","published_at" DESC);--> statement-breakpoint
CREATE INDEX "report_view_org_owner_status_idx" ON "report_view" USING btree ("organization_id","owner_membership_id","status");--> statement-breakpoint
CREATE INDEX "report_view_org_share_default_idx" ON "report_view" USING btree ("organization_id","share_scope","status") WHERE share_scope = 'org';--> statement-breakpoint
CREATE INDEX "report_schedule_org_status_next_run_idx" ON "report_schedule" USING btree ("organization_id","status","next_run_at");--> statement-breakpoint
CREATE INDEX "report_schedule_owner_status_idx" ON "report_schedule" USING btree ("owner_membership_id","status");--> statement-breakpoint
-- report_schedule_run: idempotency UNIQUE (includes the partition key scheduled_for → lives on parent).
CREATE UNIQUE INDEX "report_schedule_run_schedule_scheduled_for_uidx" ON "report_schedule_run" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "report_schedule_run_status_org_idx" ON "report_schedule_run" USING btree ("status","organization_id");--> statement-breakpoint
-- report_run: "last refresh for MV" + the failed-refresh worklist (partial, 'failed' is an immutable literal).
CREATE INDEX "report_run_mv_key_status_started_idx" ON "report_run" USING btree ("mv_key","status","started_at" DESC);--> statement-breakpoint
CREATE INDEX "report_run_status_started_idx" ON "report_run" USING btree ("status","started_at") WHERE status = 'failed';--> statement-breakpoint
-- dashboard_tile_cache: UNIQUE (org, cache_key) + the expiration-sweeper index (plain — a partial
-- WHERE expires_at > now() is illegal: now() is not IMMUTABLE in an index predicate).
CREATE UNIQUE INDEX "dashboard_tile_cache_org_cache_key_uidx" ON "dashboard_tile_cache" USING btree ("organization_id","cache_key");--> statement-breakpoint
CREATE INDEX "dashboard_tile_cache_expires_at_idx" ON "dashboard_tile_cache" USING btree ("expires_at");--> statement-breakpoint
-- report_drilldown_audit: the two parent-level navigation indexes (the trace_id UNIQUE is per-leaf, §8c).
CREATE INDEX "report_drilldown_audit_actor_accessed_idx" ON "report_drilldown_audit" USING btree ("actor_membership_id","accessed_at" DESC);--> statement-breakpoint
CREATE INDEX "report_drilldown_audit_org_module_accessed_idx" ON "report_drilldown_audit" USING btree ("organization_id","drilldown_target_module","accessed_at" DESC);
