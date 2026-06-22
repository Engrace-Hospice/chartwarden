-- M10 HOPE Engine §3.3 (RLS + grants) + §3.4 (write-audit triggers + the hope_assessment partition
-- conversion + correction-supersede / schedule-mark-completed triggers) — M10-T02.
--
-- Tables/enums/indexes/FKs land in 0034 (drizzle-generated). This migration locks:
--   • the §3.6 PARTITION BY RANGE (target_date) conversion of hope_assessment — Postgres requires
--     PARTITION BY at CREATE time, so (clinical_assessment precedent, 0033) we drop the plain table 0034
--     created and re-create it partitioned, with the same columns/PK/FKs/indexes + the DEFERRABLE self-FK
--     (corrects_assessment_id → id, the correction chain; corrections preserve target_date) + the §3.4
--     correction-supersede + schedule-mark-completed triggers. Monthly partitions (current + 12 forward) +
--     a DEFAULT catch-all, all created dynamically via format(%I) so the static phi-guards scan does not
--     mis-detect a partition child as an un-triggered org-scoped table (row triggers on the partitioned
--     parent propagate to every partition, PG11+). The M1 partition-maintenance cron rotates new months;
--   • standard app.org_id org-scope RLS on all six M10 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()); the three-column tenancy (organization_id + provider_entity_id
--     + location_id) is denormalized on the four patient-level tables for ABAC narrowing, but the RLS pivot
--     is organization_id alone. hope_submission is per-CCN (org + PE) and hope_submission_item is a join
--     row (org only) — both still org-scoped, same app.org_id RLS;
--   • the §3.6 grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (HOPE assessments
--     are append-only — a correction supersedes the prior row; submissions/items are status-transitioned,
--     never app-deleted; destruction clears via the admin-run eraseFn, M10-T08);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.1/§8.1 PHI
--     denylist (M10_AUDIT_DENYLIST): the hope_assessment `data` / clinical_context_snapshot /
--     late_completion_reason_code; the schedule + SFV alert_cadence; the finding `message`; the submission
--     acceptance_report / envelope_storage_uri / envelope_sha256; the item iqies_validation_result — so
--     free-text/PHI never lands in the audit diff (the trigger records the write + a <changed> marker,
--     never the value). All six carry organization_id, so all six get BOTH an RLS policy and a trigger
--     (arch:gaps phi-guards floor). Retention class 'compliance' (CMS HQRP / iQIES records retention;
--     submitted rows extend to 10 years via the M4 retention worker — §3.4/§11).--> statement-breakpoint
-- 1. hope_assessment: drop the plain table 0034 created, re-create RANGE-partitioned on target_date
--    (§3.6, D11). Same logical shape as the Drizzle definition; the partition + self-FK + triggers are
--    invisible to drizzle-kit (it diffs the 0034 snapshot, which carries the logical table).--> statement-breakpoint
DROP TABLE IF EXISTS "hope_assessment" CASCADE;--> statement-breakpoint
CREATE TABLE "hope_assessment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "schedule_id" uuid,
  "source_encounter_id" uuid,
  "rfa_kind" "hope_rfa_kind" NOT NULL,
  "discharge_reason" "hope_discharge_reason",
  "status" "hope_assessment_status" DEFAULT 'draft' NOT NULL,
  "data" jsonb NOT NULL,
  "j2051_max_severity" "j2051_severity" DEFAULT 'none' NOT NULL,
  "j2051_trigger_fired" boolean DEFAULT false NOT NULL,
  "was_late" boolean DEFAULT false NOT NULL,
  "late_completion_reason_code" text,
  "clinical_context_snapshot" jsonb,
  "corrects_assessment_id" uuid,
  "superseded_by_id" uuid,
  "iqies_record_id" text,
  "target_date" timestamp with time zone NOT NULL,
  "signed_at" timestamp with time zone,
  "signed_by_membership_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_membership_id" uuid NOT NULL,
  CONSTRAINT "hope_assessment_id_target_date_pk" PRIMARY KEY("id","target_date"),
  CONSTRAINT "hope_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "hope_assessment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "hope_assessment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "hope_assessment_schedule_id_hope_timepoint_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."hope_timepoint_schedule"("id"),
  CONSTRAINT "hope_assessment_signed_by_membership_id_membership_id_fk" FOREIGN KEY ("signed_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict,
  CONSTRAINT "hope_assessment_created_by_membership_id_membership_id_fk" FOREIGN KEY ("created_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict
) PARTITION BY RANGE ("target_date");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hope_assessment DEFAULT', 'hope_assessment_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_hope_assessment_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'hope_assessment_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF hope_assessment FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_hope_assessment_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
-- Self-FK as a DEFERRABLE constraint so a correction can insert in the same TX that supersedes the
-- original (the supersede trigger flips the original's status in the same TX as the correction INSERT).
-- The composite (corrects_assessment_id, target_date) → (id, target_date) means a correction preserves
-- the original's target_date (a new id for the same timepoint) — honored by the service layer (T03).--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_corrects_fk"
  FOREIGN KEY ("corrects_assessment_id", "target_date") REFERENCES "hope_assessment" ("id", "target_date")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_patient_rfa" ON "hope_assessment" USING btree ("patient_id","rfa_kind","target_date") WHERE status = 'signed';--> statement-breakpoint
CREATE INDEX "idx_hope_assess_org_triggered" ON "hope_assessment" USING btree ("organization_id","j2051_trigger_fired","signed_at") WHERE j2051_trigger_fired = true;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_org_unsubmitted" ON "hope_assessment" USING btree ("organization_id","signed_at") WHERE status = 'signed' AND iqies_record_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_corrects" ON "hope_assessment" USING btree ("corrects_assessment_id") WHERE corrects_assessment_id IS NOT NULL;--> statement-breakpoint
-- §3.4 correction-supersede: on INSERT of a correction row, flip the referenced row to superseded.--> statement-breakpoint
CREATE OR REPLACE FUNCTION hope_assessment_supersede_on_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.corrects_assessment_id IS NOT NULL THEN
    UPDATE hope_assessment
       SET status = 'superseded',
           superseded_by_id = NEW.id,
           updated_at = now()
     WHERE id = NEW.corrects_assessment_id
       AND organization_id = NEW.organization_id;  -- defense in depth (RLS-friendly)
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_hope_assessment_supersede_on_correction"
  AFTER INSERT ON hope_assessment
  FOR EACH ROW
  WHEN (NEW.corrects_assessment_id IS NOT NULL)
  EXECUTE FUNCTION hope_assessment_supersede_on_correction();--> statement-breakpoint
-- §3.4 schedule-mark-completed: when an assessment is signed against an open schedule, close it.--> statement-breakpoint
CREATE OR REPLACE FUNCTION hope_schedule_mark_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'signed' AND OLD.status = 'draft' AND NEW.schedule_id IS NOT NULL THEN
    UPDATE hope_timepoint_schedule
       SET status = 'completed',
           completed_by_assessment_id = NEW.id,
           updated_at = now()
     WHERE id = NEW.schedule_id
       AND organization_id = NEW.organization_id
       AND status = 'open';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_hope_schedule_mark_completed"
  AFTER UPDATE ON hope_assessment
  FOR EACH ROW EXECUTE FUNCTION hope_schedule_mark_completed();--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.3/§3.5). No DELETE — append-only / status-transition.--> statement-breakpoint
ALTER TABLE "hope_timepoint_schedule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hope_timepoint_schedule_org" ON "hope_timepoint_schedule";
CREATE POLICY "hope_timepoint_schedule_org" ON "hope_timepoint_schedule"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_timepoint_schedule" TO wardenx_app;
GRANT ALL ON "hope_timepoint_schedule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_assessment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hope_assessment_org" ON "hope_assessment";
CREATE POLICY "hope_assessment_org" ON "hope_assessment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_assessment" TO wardenx_app;
GRANT ALL ON "hope_assessment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "symptom_follow_up_visit_org" ON "symptom_follow_up_visit";
CREATE POLICY "symptom_follow_up_visit_org" ON "symptom_follow_up_visit"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "symptom_follow_up_visit" TO wardenx_app;
GRANT ALL ON "symptom_follow_up_visit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hope_validation_finding_org" ON "hope_validation_finding";
CREATE POLICY "hope_validation_finding_org" ON "hope_validation_finding"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_validation_finding" TO wardenx_app;
GRANT ALL ON "hope_validation_finding" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_submission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hope_submission_org" ON "hope_submission";
CREATE POLICY "hope_submission_org" ON "hope_submission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_submission" TO wardenx_app;
GRANT ALL ON "hope_submission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_submission_item" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hope_submission_item_org" ON "hope_submission_item";
CREATE POLICY "hope_submission_item_org" ON "hope_submission_item"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_submission_item" TO wardenx_app;
GRANT ALL ON "hope_submission_item" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, M10_AUDIT_DENYLIST / §3.1/§3.4/§8.1).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_timepoint_schedule() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['alert_cadence']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['alert_cadence']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_timepoint_schedule.' || lower(TG_OP),
    'hope_timepoint_schedule',
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
ALTER FUNCTION audit_phi_write_hope_timepoint_schedule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_timepoint_schedule" AFTER INSERT OR UPDATE OR DELETE ON hope_timepoint_schedule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_timepoint_schedule();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_assessment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['data', 'clinical_context_snapshot', 'late_completion_reason_code']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['data', 'clinical_context_snapshot', 'late_completion_reason_code']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_assessment.' || lower(TG_OP),
    'hope_assessment',
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
ALTER FUNCTION audit_phi_write_hope_assessment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_assessment" AFTER INSERT OR UPDATE OR DELETE ON hope_assessment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_assessment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_symptom_follow_up_visit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['alert_cadence']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['alert_cadence']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'symptom_follow_up_visit.' || lower(TG_OP),
    'symptom_follow_up_visit',
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
ALTER FUNCTION audit_phi_write_symptom_follow_up_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_symptom_follow_up_visit" AFTER INSERT OR UPDATE OR DELETE ON symptom_follow_up_visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_symptom_follow_up_visit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_validation_finding() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['message']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['message']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_validation_finding.' || lower(TG_OP),
    'hope_validation_finding',
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
ALTER FUNCTION audit_phi_write_hope_validation_finding() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_validation_finding" AFTER INSERT OR UPDATE OR DELETE ON hope_validation_finding
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_validation_finding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['acceptance_report', 'envelope_storage_uri', 'envelope_sha256']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['acceptance_report', 'envelope_storage_uri', 'envelope_sha256']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_submission.' || lower(TG_OP),
    'hope_submission',
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
ALTER FUNCTION audit_phi_write_hope_submission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_submission" AFTER INSERT OR UPDATE OR DELETE ON hope_submission
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['iqies_validation_result']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['iqies_validation_result']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_submission_item.' || lower(TG_OP),
    'hope_submission_item',
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
ALTER FUNCTION audit_phi_write_hope_submission_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_submission_item" AFTER INSERT OR UPDATE OR DELETE ON hope_submission_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_submission_item();
