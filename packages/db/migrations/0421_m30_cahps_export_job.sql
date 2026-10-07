-- GAP-087 — M30 CAHPS vendor export: a durable export JOB (R-14 / R-15) and the rendered artifact.
--
-- Before this, `POST /quality/cahps/export` synthesized a random "queued" job nothing could run and
-- `GET .../export/:id` always 404'd; the export worker rendered the vendor file and discarded it. This table
-- is the job row the route persists + enqueues, the worker drives (queued -> running -> completed|failed) and
-- R-15 reads back, and it holds the rendered file ENVELOPE-ENCRYPTED under the tenant DEK (the file carries
-- caregiver names / phones / emails — PHI — so it is never at rest in the clear; `file_cipher` is audit-scrubbed).
--
-- ORG-SCOPED (organization_id NOT NULL, FORCEd RLS on app.org_id). No DELETE for the app role: an export is
-- part of the survey-evidence trail (tenant offboarding deletes through wardenx_destruction, see the M30 eraser).
-- Idempotent.
CREATE TABLE IF NOT EXISTS "cahps_export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_binding_id" uuid NOT NULL,
	"vendor_adapter_id" text NOT NULL,
	"sampling_cycle_month" date NOT NULL,
	"sample_period_start" date NOT NULL,
	"sample_period_end" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"decedent_count" integer DEFAULT 0 NOT NULL,
	"filename" text,
	"mime_type" text,
	"file_cipher" text,
	"file_sha256" text,
	"push_status" text,
	"vendor_job_id" text,
	"failure_reason" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cahps_export_job_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cahps_export_job_status_chk" CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "cahps_export_job_push_status_chk" CHECK ("push_status" IS NULL OR "push_status" IN ('pushed', 'no_push')),
	CONSTRAINT "cahps_export_job_period_chk" CHECK ("sample_period_end" >= "sample_period_start"),
	-- A completed job always carries its artifact; a failed one always says why.
	CONSTRAINT "cahps_export_job_completed_file_chk" CHECK ("status" <> 'completed' OR ("file_cipher" IS NOT NULL AND "file_sha256" IS NOT NULL AND "completed_at" IS NOT NULL)),
	CONSTRAINT "cahps_export_job_failed_reason_chk" CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL)
);--> statement-breakpoint
-- At most one LIVE (queued/running) export per org + cycle: an R-14 retry or double-click converges on it.
CREATE UNIQUE INDEX IF NOT EXISTS "cahps_export_job_live_uq" ON "cahps_export_job" ("organization_id", "sampling_cycle_month")
	WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cahps_export_job_org_idx" ON "cahps_export_job" ("organization_id", "created_at");--> statement-breakpoint

ALTER TABLE "cahps_export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cahps_export_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "cahps_export_job_org" ON "cahps_export_job"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "cahps_export_job" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "cahps_export_job" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "cahps_export_job" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_cahps_export_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['file_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cahps_export_job.' || lower(TG_OP), 'cahps_export_job', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cahps_export_job() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_cahps_export_job" ON cahps_export_job;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cahps_export_job" AFTER INSERT OR UPDATE OR DELETE ON cahps_export_job
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cahps_export_job();
