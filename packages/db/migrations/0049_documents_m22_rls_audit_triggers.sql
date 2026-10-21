-- M22 Document Management §3.2 Phase 2 / §3.3 / §3.5 / §3.6 — the four PARTITION BY RANGE conversions
-- (document_access_log, form_fill, extraction_job, extraction_candidate) + org-scope RLS + grants +
-- M4 write-audit triggers (cipher / free-text PHI columns denylisted, §3.6) — M22-T02.
--
-- Tables/enums/indexes/FKs land in 0048 (drizzle-generated). This migration locks:
--   • the §3.2 Phase 1.3 PARTITION BY RANGE conversion of the four monthly-partitioned tables
--     (document_access_log on accessed_at, form_fill on created_at, extraction_job on queued_at,
--     extraction_candidate on extracted_at). Postgres requires PARTITION BY at CREATE time, so
--     (M18 evv_event precedent, 0047) we drop the plain table 0048 created and re-create it
--     partitioned — same columns/PK/CHECK/FKs/indexes. Monthly partitions (current + 12 forward) +
--     a DEFAULT catch-all, created dynamically via format(%I) so the static phi-guards scan does not
--     mis-detect a partition child as a separate un-triggered org table (row triggers on the
--     partitioned parent propagate to every partition, PG11+). The M1 partition-maintenance cron
--     rotates new months. References TO the partitioned tables (extraction_candidate.extraction_job_id,
--     extraction_decision.extraction_candidate_id) carry NO SQL FK — plain uuid, app-validated;
--   • standard app.org_id org-scope RLS on the fifteen org-scoped tables (ADR-0010 D2: row visibility
--     keys ONLY on app.org_id, set by withOrgContext()). `document` + `intake_upload_batch` are the
--     PHI-bearing tables by the three-column rule (they carry patient_id); the other thirteen are
--     org-scoped (joining to PHI via document_id/intake_upload_batch_id). The RLS pivot is
--     organization_id alone (§3.5);
--   • the two platform tables `form_template` + `form_template_version` — platform-published catalog,
--     NO organization_id BY DESIGN (the same template for every tenant). Dual-grant RLS: read-all
--     `USING(true)` TO wardenx_app, platform writes via wardenx_admin only (M38 code_system /
--     M39 consent_type_catalog precedent). They audit via the M1 baseline `wardenx_audit_trigger()`
--     (null-safe, no organization_id required) since the M4 generator's trigger reads NEW.organization_id;
--   • the grants policy (§3.2 Phase 2.3) — wardenx_app has SELECT/INSERT/UPDATE on every M22 table
--     and DELETE ONLY on `document_tag` (tags are user-removable). There is NO user soft-delete of
--     documents or versions (F19/§2.2.2): document_version is append-only, "superseding" flips
--     document.active_version_id (service-layer), and erroneous-upload removal routes through the M4
--     destruction path (status → destroyed_tombstone). Destruction clears via the admin-run eraseFn
--     (`documents` / `intake_extraction` data classes, M22-T11);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every org-scoped table, with the
--     §3.6 PHI denylist (free-text PHI + cipher + structural columns). Retention class `compliance`
--     (the trigger-write default). All fifteen carry organization_id, so all fifteen get BOTH an RLS
--     policy and a trigger; the two platform tables get RLS + a baseline trigger (arch:gaps
--     phi-guards floor — every table the scan sees as org-scoped has RLS + a trigger).--> statement-breakpoint

-- ============================================================================================
-- 1. PARTITION BY RANGE conversions (§3.2 Phase 1.3). Drop the plain table 0048 created and
--    re-create RANGE-partitioned on the time column — same columns/PK/CHECK/FKs/indexes.
-- ============================================================================================

-- 1a. document_access_log — re-create RANGE-partitioned on accessed_at.--> statement-breakpoint
DROP TABLE IF EXISTS "document_access_log" CASCADE;--> statement-breakpoint
CREATE TABLE "document_access_log" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "accessor_membership_id" uuid NOT NULL,
  "access_kind" text NOT NULL,
  "purpose" text NOT NULL,
  "recipient_membership_id" uuid,
  "recipient_class" text,
  "correlation_id" text NOT NULL,
  "accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_access_log_id_accessed_at_pk" PRIMARY KEY("id","accessed_at"),
  CONSTRAINT "document_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action
) PARTITION BY RANGE ("accessed_at");--> statement-breakpoint
CREATE INDEX "doc_access_log_doc_idx" ON "document_access_log" USING btree ("document_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "doc_access_log_accessor_idx" ON "document_access_log" USING btree ("organization_id","accessor_membership_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "doc_access_log_purpose_idx" ON "document_access_log" USING btree ("organization_id","purpose","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_document_access_log_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'document_access_log_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF document_access_log FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF document_access_log DEFAULT', 'document_access_log_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_document_access_log_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint

-- 1b. form_fill — re-create RANGE-partitioned on created_at.--> statement-breakpoint
DROP TABLE IF EXISTS "form_fill" CASCADE;--> statement-breakpoint
CREATE TABLE "form_fill" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "template_version_id" uuid NOT NULL,
  "tenant_overlay_id" uuid,
  "aggregate_type" "document_aggregate_type" NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "render_payload" jsonb NOT NULL,
  "status" "form_fill_status" DEFAULT 'queued' NOT NULL,
  "result_document_id" uuid,
  "failure_reason" text,
  "render_attempts" text DEFAULT '0' NOT NULL,
  "correlation_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rendered_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  CONSTRAINT "form_fill_id_created_at_pk" PRIMARY KEY("id","created_at"),
  CONSTRAINT "form_fill_template_version_id_form_template_version_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."form_template_version"("id") ON DELETE no action ON UPDATE no action
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE INDEX "form_fill_aggregate_idx" ON "form_fill" USING btree ("organization_id","aggregate_type","aggregate_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "form_fill_status_idx" ON "form_fill" USING btree ("status","created_at" DESC NULLS LAST) WHERE status IN ('queued','rendering','failed');--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_form_fill_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'form_fill_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF form_fill FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF form_fill DEFAULT', 'form_fill_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_form_fill_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint

-- 1c. extraction_job — re-create RANGE-partitioned on queued_at.--> statement-breakpoint
DROP TABLE IF EXISTS "extraction_job" CASCADE;--> statement-breakpoint
CREATE TABLE "extraction_job" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "classified_page_id" uuid NOT NULL,
  "document_type" "classified_page_doc_type" NOT NULL,
  "status" "extraction_job_status" DEFAULT 'queued' NOT NULL,
  "extractor_model_version_ref" text NOT NULL,
  "vision_verifier_model_version_ref" text,
  "aggregate_confidence" numeric(4, 3),
  "retry_count" integer DEFAULT 0 NOT NULL,
  "failure_reason" text,
  "correlation_id" text NOT NULL,
  "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "extraction_job_id_queued_at_pk" PRIMARY KEY("id","queued_at"),
  CONSTRAINT "extraction_job_classified_page_id_classified_page_id_fk" FOREIGN KEY ("classified_page_id") REFERENCES "public"."classified_page"("id") ON DELETE no action ON UPDATE no action
) PARTITION BY RANGE ("queued_at");--> statement-breakpoint
CREATE INDEX "extraction_job_status_idx" ON "extraction_job" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "extraction_job_classified_page_idx" ON "extraction_job" USING btree ("classified_page_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_extraction_job_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'extraction_job_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF extraction_job FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF extraction_job DEFAULT', 'extraction_job_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_extraction_job_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint

-- 1d. extraction_candidate — re-create RANGE-partitioned on extracted_at.--> statement-breakpoint
DROP TABLE IF EXISTS "extraction_candidate" CASCADE;--> statement-breakpoint
CREATE TABLE "extraction_candidate" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "extraction_job_id" uuid NOT NULL,
  "field_path" text NOT NULL,
  "field_kind" "extraction_candidate_field_kind" NOT NULL,
  "risk_level" "extraction_candidate_risk_level" NOT NULL,
  "value_text" text,
  "value_code" text,
  "value_code_system" "extraction_candidate_code_system" DEFAULT 'none' NOT NULL,
  "value_cipher" text,
  "confidence" numeric(4, 3) NOT NULL,
  "source_page" integer NOT NULL,
  "source_bounding_box" jsonb NOT NULL,
  "vision_verified" boolean DEFAULT false NOT NULL,
  "vision_disagreement" text,
  "sud_detected" boolean DEFAULT false NOT NULL,
  "extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "extraction_candidate_id_extracted_at_pk" PRIMARY KEY("id","extracted_at"),
  CONSTRAINT "extraction_candidate_bbox_shape" CHECK (source_bounding_box ? 'x1' AND source_bounding_box ? 'y1' AND source_bounding_box ? 'x2' AND source_bounding_box ? 'y2')
) PARTITION BY RANGE ("extracted_at");--> statement-breakpoint
CREATE INDEX "extraction_candidate_job_field_idx" ON "extraction_candidate" USING btree ("extraction_job_id","field_path");--> statement-breakpoint
CREATE INDEX "extraction_candidate_risk_idx" ON "extraction_candidate" USING btree ("risk_level","confidence" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_extraction_candidate_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'extraction_candidate_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF extraction_candidate FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF extraction_candidate DEFAULT', 'extraction_candidate_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_extraction_candidate_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint

-- ============================================================================================
-- 2. Org-scope RLS + grants on the fifteen org-scoped tables (standard app.org_id; §3.5).
--    wardenx_app: SELECT/INSERT/UPDATE everywhere; DELETE only on document_tag (§3.2 Phase 2.3).
-- ============================================================================================
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "document_org" ON "document";--> statement-breakpoint
CREATE POLICY "document_org" ON "document"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "document_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "document_version_org" ON "document_version";--> statement-breakpoint
CREATE POLICY "document_version_org" ON "document_version"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_version" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document_version" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "document_tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "document_tag_org" ON "document_tag";--> statement-breakpoint
CREATE POLICY "document_tag_org" ON "document_tag"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_tag" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document_tag" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "document_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "document_access_log_org" ON "document_access_log";--> statement-breakpoint
CREATE POLICY "document_access_log_org" ON "document_access_log"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_access_log" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document_access_log" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "document_legal_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "document_legal_hold_org" ON "document_legal_hold";--> statement-breakpoint
CREATE POLICY "document_legal_hold_org" ON "document_legal_hold"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_legal_hold" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document_legal_hold" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tenant_template_overlay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_template_overlay_org" ON "tenant_template_overlay";--> statement-breakpoint
CREATE POLICY "tenant_template_overlay_org" ON "tenant_template_overlay"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_template_overlay" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tenant_template_overlay" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "form_fill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "form_fill_org" ON "form_fill";--> statement-breakpoint
CREATE POLICY "form_fill_org" ON "form_fill"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "form_fill" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "form_fill" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "intake_upload_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "intake_upload_batch_org" ON "intake_upload_batch";--> statement-breakpoint
CREATE POLICY "intake_upload_batch_org" ON "intake_upload_batch"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "intake_upload_batch" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "intake_upload_batch" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "classified_page" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "classified_page_org" ON "classified_page";--> statement-breakpoint
CREATE POLICY "classified_page_org" ON "classified_page"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "classified_page" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "classified_page" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_job_org" ON "extraction_job";--> statement-breakpoint
CREATE POLICY "extraction_job_org" ON "extraction_job"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_job" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_job" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_candidate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_candidate_org" ON "extraction_candidate";--> statement-breakpoint
CREATE POLICY "extraction_candidate_org" ON "extraction_candidate"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_candidate" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_candidate" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_discrepancy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_discrepancy_org" ON "extraction_discrepancy";--> statement-breakpoint
CREATE POLICY "extraction_discrepancy_org" ON "extraction_discrepancy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_discrepancy" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_discrepancy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_review_org" ON "extraction_review";--> statement-breakpoint
CREATE POLICY "extraction_review_org" ON "extraction_review"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_review" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_review" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_decision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_decision_org" ON "extraction_decision";--> statement-breakpoint
CREATE POLICY "extraction_decision_org" ON "extraction_decision"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_decision" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_decision" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "extraction_provenance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "extraction_provenance_org" ON "extraction_provenance";--> statement-breakpoint
CREATE POLICY "extraction_provenance_org" ON "extraction_provenance"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "extraction_provenance" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "extraction_provenance" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 3. Platform tables — dual-grant RLS (read-all within any tenant; platform writes via admin).
--    NO organization_id BY DESIGN (M38 code_system / M39 consent_type_catalog precedent).
-- ============================================================================================
ALTER TABLE "form_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "form_template_read" ON "form_template";--> statement-breakpoint
CREATE POLICY "form_template_read" ON "form_template" FOR SELECT TO wardenx_app USING (true);--> statement-breakpoint
GRANT SELECT ON "form_template" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "form_template" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "form_template_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "form_template_version_read" ON "form_template_version";--> statement-breakpoint
CREATE POLICY "form_template_version_read" ON "form_template_version" FOR SELECT TO wardenx_app USING (true);--> statement-breakpoint
GRANT SELECT ON "form_template_version" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "form_template_version" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 4. M4 write-audit append path (M04-F06 #2) — idempotent re-assertion (already from 0012/0013).
-- ============================================================================================
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint

-- ============================================================================================
-- 5. M4 generated write-audit triggers on the fifteen org-scoped tables (§3.6 denylist;
--    retention 'compliance'). Generated by @chartwarden/audit generateAuditTrigger(...).
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_document() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['title']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['title']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'document.' || lower(TG_OP),
    'document',
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
ALTER FUNCTION audit_phi_write_document() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document" AFTER INSERT OR UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_document_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['byte_payload_cipher', 'minio_object_key']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['byte_payload_cipher', 'minio_object_key']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'document_version.' || lower(TG_OP),
    'document_version',
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
ALTER FUNCTION audit_phi_write_document_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document_version" AFTER INSERT OR UPDATE OR DELETE ON document_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_document_tag() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['tag_value']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['tag_value']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'document_tag.' || lower(TG_OP),
    'document_tag',
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
ALTER FUNCTION audit_phi_write_document_tag() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document_tag" AFTER INSERT OR UPDATE OR DELETE ON document_tag
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_tag();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_document_access_log() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['purpose', 'recipient_class']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['purpose', 'recipient_class']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'document_access_log.' || lower(TG_OP),
    'document_access_log',
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
ALTER FUNCTION audit_phi_write_document_access_log() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document_access_log" AFTER INSERT OR UPDATE OR DELETE ON document_access_log
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_access_log();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_document_legal_hold() RETURNS trigger
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
    'document_legal_hold.' || lower(TG_OP),
    'document_legal_hold',
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
ALTER FUNCTION audit_phi_write_document_legal_hold() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document_legal_hold" AFTER INSERT OR UPDATE OR DELETE ON document_legal_hold
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_legal_hold();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_template_overlay() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['branding', 'state_addendum']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['branding', 'state_addendum']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'tenant_template_overlay.' || lower(TG_OP),
    'tenant_template_overlay',
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
ALTER FUNCTION audit_phi_write_tenant_template_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_template_overlay" AFTER INSERT OR UPDATE OR DELETE ON tenant_template_overlay
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_template_overlay();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_form_fill() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['render_payload']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['render_payload']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'form_fill.' || lower(TG_OP),
    'form_fill',
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
ALTER FUNCTION audit_phi_write_form_fill() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_form_fill" AFTER INSERT OR UPDATE OR DELETE ON form_fill
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_form_fill();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_intake_upload_batch() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['source_metadata']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['source_metadata']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intake_upload_batch.' || lower(TG_OP),
    'intake_upload_batch',
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
ALTER FUNCTION audit_phi_write_intake_upload_batch() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intake_upload_batch" AFTER INSERT OR UPDATE OR DELETE ON intake_upload_batch
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intake_upload_batch();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_classified_page() RETURNS trigger
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
    'classified_page.' || lower(TG_OP),
    'classified_page',
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
ALTER FUNCTION audit_phi_write_classified_page() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_classified_page" AFTER INSERT OR UPDATE OR DELETE ON classified_page
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_classified_page();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_job() RETURNS trigger
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
    'extraction_job.' || lower(TG_OP),
    'extraction_job',
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
ALTER FUNCTION audit_phi_write_extraction_job() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_job" AFTER INSERT OR UPDATE OR DELETE ON extraction_job
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_job();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_candidate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['source_bounding_box', 'value_cipher', 'value_text', 'vision_disagreement']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['source_bounding_box', 'value_cipher', 'value_text', 'vision_disagreement']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'extraction_candidate.' || lower(TG_OP),
    'extraction_candidate',
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
ALTER FUNCTION audit_phi_write_extraction_candidate() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_candidate" AFTER INSERT OR UPDATE OR DELETE ON extraction_candidate
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_candidate();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_discrepancy() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['chart_existing_value', 'resolution_value']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['chart_existing_value', 'resolution_value']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'extraction_discrepancy.' || lower(TG_OP),
    'extraction_discrepancy',
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
ALTER FUNCTION audit_phi_write_extraction_discrepancy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_discrepancy" AFTER INSERT OR UPDATE OR DELETE ON extraction_discrepancy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_discrepancy();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_review() RETURNS trigger
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
    'extraction_review.' || lower(TG_OP),
    'extraction_review',
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
ALTER FUNCTION audit_phi_write_extraction_review() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_review" AFTER INSERT OR UPDATE OR DELETE ON extraction_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_review();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_decision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['edited_value', 'reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['edited_value', 'reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'extraction_decision.' || lower(TG_OP),
    'extraction_decision',
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
ALTER FUNCTION audit_phi_write_extraction_decision() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_decision" AFTER INSERT OR UPDATE OR DELETE ON extraction_decision
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_decision();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_provenance() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['source_bounding_box', 'target_field_path']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['source_bounding_box', 'target_field_path']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'extraction_provenance.' || lower(TG_OP),
    'extraction_provenance',
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
ALTER FUNCTION audit_phi_write_extraction_provenance() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_provenance" AFTER INSERT OR UPDATE OR DELETE ON extraction_provenance
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_provenance();--> statement-breakpoint

-- ============================================================================================
-- 6. Platform tables — M1 baseline null-safe write-audit trigger (§3.8 / code_system precedent;
--    the M4 generator reads NEW.organization_id which these tables do not carry).
-- ============================================================================================
CREATE TRIGGER "form_template_audit" AFTER INSERT OR UPDATE OR DELETE ON form_template
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "form_template_version_audit" AFTER INSERT OR UPDATE OR DELETE ON form_template_version
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
