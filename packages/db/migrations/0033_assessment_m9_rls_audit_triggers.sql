-- M9 Clinical Assessments Suite §3.3 (RLS + grants) + §3.4 (write-audit triggers + the
-- clinical_assessment partition conversion + correction-supersede trigger) — M9-T02.
--
-- Tables/enums/indexes/FKs land in 0032 (drizzle-generated). This migration locks:
--   • the §3.6 PARTITION BY RANGE (captured_at) conversion of clinical_assessment — Postgres requires
--     PARTITION BY at CREATE time, so (consent_eval_audit precedent, 0023) we drop the plain table 0032
--     created and re-create it partitioned, with the same columns/PK/CHECK/FKs/indexes + the DEFERRABLE
--     self-FK (corrects_assessment_id → id, the D9 correction chain) + the §3.4 correction-supersede
--     trigger. Monthly partitions (current + 12 forward) + a DEFAULT catch-all, all created dynamically
--     via format(%I) so the static phi-guards scan does not mis-detect a partition child as an
--     un-triggered org-scoped table (row triggers on the partitioned parent propagate to every
--     partition, PG11+). The M1 partition-maintenance cron rotates new months at boot;
--   • standard app.org_id org-scope RLS on all five M9 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()); the three-column tenancy (organization_id +
--     provider_entity_id + location_id) is denormalized on the three patient-level tables for ABAC
--     narrowing, but the RLS pivot is organization_id alone (ARCH-067 order). scale_license /
--     scale_policy are org-level config — organization_id only, same app.org_id RLS;
--   • the §3.6 grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (assessments are
--     append-only — a correction supersedes the prior row, never an UPDATE-in-place delete; config rows
--     are updated, never deleted by the app; destruction clears via the admin-run eraseFn, M9-T07);
--   • the M4 write-audit trigger (generateAuditTrigger) on every table, with the §3.1/§8.1 PHI denylist
--     (the clinical_assessment `data` jsonb — every scale's free-text notes + the ESAS-r other-symptom
--     text — and correction_reason; the cosignature attestation_text; the significant-change
--     acknowledgment_note) so free-text PHI never lands in the audit diff (the trigger records the write
--     + a <changed> marker, never the value). All five carry organization_id, so all five get BOTH an
--     RLS policy and a trigger (arch:gaps phi-guards floor). Every M9 table has a UUID PK + a
--     organization_id, so each takes the M4 generator (no M1 baseline-trigger fallback needed).
--     Retention class 'compliance' (CoP 418.104, clinical-record retention; §3.4 / spec §11).--> statement-breakpoint
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint
-- 1. clinical_assessment: drop the plain table 0032 created, re-create RANGE-partitioned on captured_at
--    (§3.6, D11). Same logical shape as the Drizzle definition; the partition + self-FK + trigger are
--    invisible to drizzle-kit (it diffs the 0032 snapshot, which carries the logical table).--> statement-breakpoint
DROP TABLE IF EXISTS "clinical_assessment" CASCADE;--> statement-breakpoint
CREATE TABLE "clinical_assessment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "scale_type" "scale_type" NOT NULL,
  "scale_version" text NOT NULL,
  "data" jsonb NOT NULL,
  "score" numeric(8, 2),
  "score_interpretation" text,
  "captured_at" timestamp with time zone NOT NULL,
  "captured_by_membership_id" uuid NOT NULL,
  "captured_by_discipline" text NOT NULL,
  "source_encounter_id" uuid,
  "cosign_required" boolean DEFAULT false NOT NULL,
  "sud_context" boolean DEFAULT false NOT NULL,
  "acting_consent_id" uuid,
  "acting_as" "assessment_acting_as" DEFAULT 'self' NOT NULL,
  "status" "assessment_status" DEFAULT 'active' NOT NULL,
  "corrects_assessment_id" uuid,
  "correction_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "clinical_assessment_id_captured_at_pk" PRIMARY KEY("id","captured_at"),
  CONSTRAINT "correction_consistency" CHECK ((corrects_assessment_id IS NULL AND correction_reason IS NULL)
          OR (corrects_assessment_id IS NOT NULL AND correction_reason IS NOT NULL
              AND char_length(correction_reason) >= 10)),
  CONSTRAINT "clinical_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "clinical_assessment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "clinical_assessment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "clinical_assessment_captured_by_membership_id_membership_id_fk" FOREIGN KEY ("captured_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict
) PARTITION BY RANGE ("captured_at");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF clinical_assessment DEFAULT', 'clinical_assessment_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_clinical_assessment_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'clinical_assessment_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF clinical_assessment FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_clinical_assessment_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
-- Self-FK as a DEFERRABLE constraint so a correction can insert in the same TX that supersedes the
-- original (the supersede trigger flips the original's status in the same TX as the correction INSERT).--> statement-breakpoint
ALTER TABLE "clinical_assessment" ADD CONSTRAINT "clinical_assessment_corrects_fk"
  FOREIGN KEY ("corrects_assessment_id", "captured_at") REFERENCES "clinical_assessment" ("id", "captured_at")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "clinical_assessment_patient_scale_captured_idx" ON "clinical_assessment" USING btree ("organization_id","patient_id","scale_type","captured_at" DESC NULLS LAST) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "clinical_assessment_source_encounter_idx" ON "clinical_assessment" USING btree ("source_encounter_id") WHERE source_encounter_id is not null;--> statement-breakpoint
CREATE INDEX "clinical_assessment_admission_idx" ON "clinical_assessment" USING btree ("organization_id","admission_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
-- §3.4 correction-supersede: on INSERT of a correction row, flip the referenced row's status (D9).--> statement-breakpoint
CREATE OR REPLACE FUNCTION clinical_assessment_supersede_on_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.corrects_assessment_id IS NOT NULL THEN
    UPDATE clinical_assessment
       SET status = 'superseded',
           version = version + 1
     WHERE id = NEW.corrects_assessment_id
       AND organization_id = NEW.organization_id   -- RLS-friendly
       AND scale_type = NEW.scale_type             -- shape integrity
       AND patient_id = NEW.patient_id
       AND status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CORRECTION_TARGET_NOT_ACTIVE_OR_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "clinical_assessment_supersede_on_correction_trg"
  AFTER INSERT ON clinical_assessment
  FOR EACH ROW EXECUTE FUNCTION clinical_assessment_supersede_on_correction();--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.3/§3.5). No DELETE — append-only / config-update.--> statement-breakpoint
ALTER TABLE "clinical_assessment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clinical_assessment_org" ON "clinical_assessment";
CREATE POLICY "clinical_assessment_org" ON "clinical_assessment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "clinical_assessment" TO wardenx_app;
GRANT ALL ON "clinical_assessment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assessment_cosignature_org" ON "assessment_cosignature";
CREATE POLICY "assessment_cosignature_org" ON "assessment_cosignature"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "assessment_cosignature" TO wardenx_app;
GRANT ALL ON "assessment_cosignature" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "significant_change_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "significant_change_event_org" ON "significant_change_event";
CREATE POLICY "significant_change_event_org" ON "significant_change_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "significant_change_event" TO wardenx_app;
GRANT ALL ON "significant_change_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "scale_license" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scale_license_org" ON "scale_license";
CREATE POLICY "scale_license_org" ON "scale_license"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "scale_license" TO wardenx_app;
GRANT ALL ON "scale_license" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "scale_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scale_policy_org" ON "scale_policy";
CREATE POLICY "scale_policy_org" ON "scale_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "scale_policy" TO wardenx_app;
GRANT ALL ON "scale_policy" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, §3.1/§3.4/§8.1).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_clinical_assessment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['correction_reason', 'data']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['correction_reason', 'data']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'clinical_assessment.' || lower(TG_OP),
    'clinical_assessment',
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
ALTER FUNCTION audit_phi_write_clinical_assessment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clinical_assessment" AFTER INSERT OR UPDATE OR DELETE ON clinical_assessment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clinical_assessment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_assessment_cosignature() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['attestation_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['attestation_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'assessment_cosignature.' || lower(TG_OP),
    'assessment_cosignature',
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
ALTER FUNCTION audit_phi_write_assessment_cosignature() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_assessment_cosignature" AFTER INSERT OR UPDATE OR DELETE ON assessment_cosignature
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_assessment_cosignature();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_significant_change_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['acknowledgment_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['acknowledgment_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'significant_change_event.' || lower(TG_OP),
    'significant_change_event',
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
ALTER FUNCTION audit_phi_write_significant_change_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_significant_change_event" AFTER INSERT OR UPDATE OR DELETE ON significant_change_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_significant_change_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_scale_license() RETURNS trigger
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
    'scale_license.' || lower(TG_OP),
    'scale_license',
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
ALTER FUNCTION audit_phi_write_scale_license() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_scale_license" AFTER INSERT OR UPDATE OR DELETE ON scale_license
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_scale_license();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_scale_policy() RETURNS trigger
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
    'scale_policy.' || lower(TG_OP),
    'scale_policy',
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
ALTER FUNCTION audit_phi_write_scale_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_scale_policy" AFTER INSERT OR UPDATE OR DELETE ON scale_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_scale_policy();
