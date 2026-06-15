-- M1 Foundation §3.11 — Initial migration layer: DB roles, append-only GRANT model,
-- audit_event RANGE partitioning + monthly rotation, and per-table RLS keyed ONLY on
-- the canonical `app.org_id` session variable (ADR-0010 D2). Runs after 0000 (the
-- Drizzle-generated table + enum DDL).
--
-- Tenancy invariants enforced here (check-tenancy.ts): canonical app.org_id only; no
-- NULL-org branch in any tenant-writable policy (the single global-read exception
-- lives isolated in 0002). The audit_event INSERT path is NOT granted to
-- wardenx_app — it writes only via the SECURITY DEFINER wardenx_audit_writer role
-- whose INSERT policy lands with M4 (M04-F06).

-- Extensions ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint

-- Database roles ------------------------------------------------------------
-- Application role: backend connections via PgBouncer run as wardenx_app and are
-- subject to RLS. Admin role: migrations / emergency ops only (RLS-bypassing).
-- Audit-writer role: the SECURITY DEFINER identity the audit() helper assumes to
-- append to audit_event (its INSERT policy is defined in M4's migration).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_app') THEN
    CREATE ROLE wardenx_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_admin') THEN
    CREATE ROLE wardenx_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_readonly') THEN
    CREATE ROLE wardenx_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_audit_writer') THEN
    CREATE ROLE wardenx_audit_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wardenx_app;--> statement-breakpoint
GRANT ALL ON SCHEMA public TO wardenx_admin;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wardenx_readonly;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wardenx_audit_writer;--> statement-breakpoint

-- audit_event → partitioned, append-only -----------------------------------
-- Drizzle (0000) emits audit_event as a plain table; recreate it RANGE-partitioned
-- on created_at. The partition column is part of the PRIMARY KEY (id, created_at) —
-- required for a partitioned table (ADR-0022 D1.1).
DROP TABLE IF EXISTS "audit_event" CASCADE;--> statement-breakpoint
CREATE TABLE "audit_event" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "organization_id" uuid,
  "actor_user_id" uuid,
  "actor_kind" "audit_actor_kind" NOT NULL,
  "actor_role" text,
  "event_type" text NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_id" uuid,
  "correlation_id" text NOT NULL,
  "request_id" text,
  "trace_id" text,
  "source_ip" text,
  "user_agent" text,
  "outcome" "audit_outcome" NOT NULL,
  "severity" "audit_severity" NOT NULL DEFAULT 'info',
  "before" jsonb,
  "after" jsonb,
  "context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "retention_class" "audit_retention_class" NOT NULL DEFAULT 'compliance',
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null;--> statement-breakpoint

-- Catch-all partition + helper to create monthly partitions on demand.
CREATE TABLE "audit_event_default" PARTITION OF "audit_event" DEFAULT;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_audit_partition(start_date DATE)
RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  end_date DATE;
BEGIN
  partition_name := 'audit_event_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- Seed current + next 3 months; the rotation worker keeps the window ahead (M01-F11).
SELECT create_audit_partition(date_trunc('month', NOW())::date);--> statement-breakpoint
SELECT create_audit_partition((date_trunc('month', NOW()) + INTERVAL '1 month')::date);--> statement-breakpoint
SELECT create_audit_partition((date_trunc('month', NOW()) + INTERVAL '2 month')::date);--> statement-breakpoint
SELECT create_audit_partition((date_trunc('month', NOW()) + INTERVAL '3 month')::date);--> statement-breakpoint

-- Re-create audit_event indexes (the DROP took them with the old table).
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_event_event_type_created_idx" ON "audit_event" ("event_type", "created_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_user_created_idx" ON "audit_event" ("actor_user_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_event_resource_idx" ON "audit_event" ("resource_kind", "resource_id");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_idx" ON "audit_event" ("correlation_id");--> statement-breakpoint

-- Sanity bounds. NB: NOT a subquery (check-ddl-legality.ts rule 2) — plain predicates.
ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_created_at_check"
  CHECK ("created_at" > '2020-01-01' AND "created_at" < NOW() + INTERVAL '1 day');--> statement-breakpoint

COMMENT ON TABLE "audit_event" IS 'Append-only audit trail. INSERT/SELECT only; no UPDATE/DELETE granted to wardenx_app. Writes go through wardenx_audit_writer (M4).';--> statement-breakpoint
COMMENT ON COLUMN "audit_event"."retention_class" IS 'Drives partition retention: operational=1yr, compliance=7yr (HIPAA floor 6, ADR-0004), legal_hold=indefinite';--> statement-breakpoint

-- Append-only GRANT model ---------------------------------------------------
-- wardenx_app gets full DML on tenant-scoped operational tables, but only
-- INSERT/SELECT on audit_event (no UPDATE/DELETE — the append-only guarantee).
GRANT INSERT, SELECT ON "audit_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "audit_event" TO wardenx_admin;--> statement-breakpoint
GRANT INSERT, SELECT, UPDATE, DELETE ON
  "organization", "provider_entity", "location", "user", "membership", "session",
  "account", "verification", "system_status", "feature_flag", "feature_flag_evaluation",
  "idempotency_key", "outbox_event", "organization_settings_registry", "outbox_event_catalog"
TO wardenx_app;--> statement-breakpoint

-- Row-Level Security --------------------------------------------------------
-- Enable RLS on every tenant-scoped table. user/session/account/verification stay
-- un-RLS'd: a user spans orgs, so org context is applied at the app layer.
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_entity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Tenancy-spine policies: an org sees only its own row (and rows scoped to it).
CREATE POLICY "organization_self" ON "organization"
  FOR ALL TO wardenx_app
  USING ("id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "provider_entity_org" ON "provider_entity"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- location is org-scoped via its provider_entity (no direct organization_id column).
CREATE POLICY "location_org" ON "location"
  FOR ALL TO wardenx_app
  USING (
    "provider_entity_id" IN (
      SELECT "id" FROM "provider_entity"
      WHERE "organization_id" = current_setting('app.org_id', true)::uuid
    )
  );--> statement-breakpoint
CREATE POLICY "membership_org" ON "membership"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- audit_event: tenants may READ only their own org's rows (SEC-035 / M01-F06b).
-- There is deliberately no WITH CHECK / FOR ALL here — wardenx_app cannot write
-- audit_event (writes go through wardenx_audit_writer, M4). Platform-wide (org-NULL)
-- rows are visible only through the platform context.
CREATE POLICY "audit_event_org_read" ON "audit_event"
  FOR SELECT TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- feature_flag: per-command write policies. The WITH CHECK never admits a NULL org,
-- so a tenant context can neither create nor mutate a GLOBAL flag or kill-switch
-- (M01-F06a). The global-read exception (org-NULL) is isolated in migration 0002.
CREATE POLICY "feature_flag_org_insert" ON "feature_flag"
  FOR INSERT TO wardenx_app
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "feature_flag_org_update" ON "feature_flag"
  FOR UPDATE TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "feature_flag_org_delete" ON "feature_flag"
  FOR DELETE TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

CREATE POLICY "idempotency_key_org" ON "idempotency_key"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "outbox_event_org" ON "outbox_event"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);