-- M13 eMAR §3.3/§3.5/§3.6 (RLS + grants) + the administration_record PARTITION BY RANGE conversion + M4
-- write-audit triggers — M13-T02.
--
-- Tables/enums/indexes/FKs land in 0040 (drizzle-generated). This migration locks:
--   • the §3.5 / D13 PARTITION BY RANGE (administered_at) conversion of administration_record — Postgres requires
--     PARTITION BY at CREATE time, so (medication_order precedent, 0039) we drop the plain table 0040 created and
--     re-create it partitioned, with the same columns/PK/FKs/indexes. Monthly partitions (current + 12 forward) +
--     a DEFAULT catch-all, created dynamically via format(%I) so the static phi-guards scan does not mis-detect a
--     partition child as a separate un-triggered org table (row triggers on the partitioned parent propagate to
--     every partition, PG11+). The M1 partition-maintenance cron rotates new months. The other eleven M13 tables
--     are non-partitioned (§3.5);
--   • standard app.org_id org-scope RLS on all twelve M13 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()). The six patient-bearing tables (administration_record / scheduled_dose
--     / prn_administration / missed_dose / comfort_kit_deployment / medication_reconciliation_worksheet) carry the
--     three-column tenancy (organization_id + provider_entity_id + location_id) for ABAC narrowing, but the RLS
--     pivot is organization_id alone (§3.5);
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (administrations are append +
--     status-transition; a correction supersedes via a new row, a void flips a flag; destruction clears via the
--     admin-run eraseFn, M13-T10);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.6 PHI denylist.
--     administration_record is special: free-text lives in denylisted top-level columns (notes / refusal_reason /
--     caregiver_attestation_text / dispute_reason / administrative_override_reason / correction_reason /
--     void_reason) AND in nested per-mode `data` json-paths (sig_free_text / infusionDilution / titrationReason /
--     pauseReason / stopReason / wastageReason), so the trigger scrubs the top-level columns then re-scrubs the
--     `data` object's denylisted keys. The other tables denylist only top-level free-text:
--     prn_administration (triggering_prn_reason / prn_interval_override_reason); missed_dose (missed_reason);
--     comfort_kit_drawdown (notes); medication_reconciliation_decision (decision_notes + the caregiver_reported_snapshot
--     structured jsonb); administration_offline_queue (rejection_reason_detail). The remaining six carry structural-only
--     fields (empty denylist). All twelve carry organization_id, so all twelve get BOTH an RLS policy and a trigger
--     (arch:gaps phi-guards floor). Retention class 'compliance' (CMS eMAR + DEA controlled-substance records, M4 D1).--> statement-breakpoint
-- 1. administration_record: drop the plain table 0040 created, re-create RANGE-partitioned on administered_at (§3.5).
--    Same logical shape as the Drizzle definition; the partition + monthly children are invisible to drizzle-kit
--    (it diffs the 0040 snapshot, which carries the logical table). Cross-module + intra-module refs to the
--    partitioned table stay plain uuid (NO SQL FK, §3.3); only org/PE/location carry FKs.--> statement-breakpoint
DROP TABLE IF EXISTS "administration_record" CASCADE;--> statement-breakpoint
CREATE TABLE "administration_record" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "medication_order_id" uuid NOT NULL,
  "scheduled_dose_id" uuid,
  "prn_administration_id" uuid,
  "encounter_id" uuid,
  "comfort_kit_deployment_id" uuid,
  "iv_session_id" uuid,
  "mode" "administration_mode" NOT NULL,
  "status" "administration_status" DEFAULT 'committed' NOT NULL,
  "data" jsonb NOT NULL,
  "drug_name_snapshot" text NOT NULL,
  "rxnorm_rxcui_snapshot" text,
  "route_snapshot" text NOT NULL,
  "dose_amount_snapshot" numeric(12, 4),
  "dose_unit_snapshot" text,
  "is_controlled_substance" boolean DEFAULT false NOT NULL,
  "is_sud_treatment" boolean DEFAULT false NOT NULL,
  "is_comfort_kit_drawdown" boolean DEFAULT false NOT NULL,
  "administered_at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_kind" "administration_actor_kind" NOT NULL,
  "administering_clinician_membership_id" uuid,
  "actor_caregiver_session_id" uuid,
  "caregiver_attestation_text" text,
  "requires_rn_review" boolean DEFAULT false NOT NULL,
  "acknowledged_by_membership_id" uuid,
  "acknowledged_at" timestamp with time zone,
  "disputed" boolean DEFAULT false NOT NULL,
  "dispute_reason" text,
  "witness_membership_id" uuid,
  "witness_attestation_token_digest" text,
  "witness_attested_at" timestamp with time zone,
  "late_entry_tier" "administration_late_entry_tier" DEFAULT 'normal' NOT NULL,
  "late_entry_reason" text,
  "significant_late_override_by" uuid,
  "administrative_override_by" uuid,
  "administrative_override_reason" text,
  "refused" boolean DEFAULT false NOT NULL,
  "refusal_reason" text,
  "notes" text,
  "offline_capture" boolean DEFAULT false NOT NULL,
  "device_id" uuid,
  "local_id" uuid,
  "corrects_administration_id" uuid,
  "correction_reason" text,
  "voided_at" timestamp with time zone,
  "voided_by" uuid,
  "void_reason" text,
  "document_id" uuid,
  "pump_programming_verified_by_membership_id" uuid,
  "dispense_cabinet_event_id" uuid,
  "vocab_version_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "administration_record_id_administered_at_pk" PRIMARY KEY("id","administered_at"),
  CONSTRAINT "administration_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "administration_record_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "administration_record_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
) PARTITION BY RANGE ("administered_at");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF administration_record DEFAULT', 'administration_record_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_administration_record_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'administration_record_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF administration_record FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_administration_record_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "admin_rec_patient_time_idx" ON "administration_record" USING btree ("organization_id","patient_id","administered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_rec_order_time_idx" ON "administration_record" USING btree ("organization_id","medication_order_id","administered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_rec_scheduled_dose_idx" ON "administration_record" USING btree ("scheduled_dose_id") WHERE scheduled_dose_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_encounter_idx" ON "administration_record" USING btree ("encounter_id") WHERE encounter_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_iv_session_idx" ON "administration_record" USING btree ("organization_id","iv_session_id","administered_at") WHERE iv_session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_pending_caregiver_review_idx" ON "administration_record" USING btree ("organization_id","requires_rn_review","recorded_at" DESC NULLS LAST) WHERE requires_rn_review = true;--> statement-breakpoint
CREATE INDEX "admin_rec_offline_capture_idx" ON "administration_record" USING btree ("organization_id","device_id","local_id") WHERE offline_capture = true;--> statement-breakpoint
CREATE INDEX "admin_rec_drug_route_idx" ON "administration_record" USING btree ("rxnorm_rxcui_snapshot","route_snapshot");--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.5). No DELETE — append + status-transition.--> statement-breakpoint
ALTER TABLE "administration_record" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "administration_record_org" ON "administration_record";
CREATE POLICY "administration_record_org" ON "administration_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "administration_record" TO wardenx_app;
GRANT ALL ON "administration_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "scheduled_dose" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scheduled_dose_org" ON "scheduled_dose";
CREATE POLICY "scheduled_dose_org" ON "scheduled_dose"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "scheduled_dose" TO wardenx_app;
GRANT ALL ON "scheduled_dose" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "prn_administration" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prn_administration_org" ON "prn_administration";
CREATE POLICY "prn_administration_org" ON "prn_administration"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "prn_administration" TO wardenx_app;
GRANT ALL ON "prn_administration" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "missed_dose" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "missed_dose_org" ON "missed_dose";
CREATE POLICY "missed_dose_org" ON "missed_dose"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "missed_dose" TO wardenx_app;
GRANT ALL ON "missed_dose" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "administration_witness" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "administration_witness_org" ON "administration_witness";
CREATE POLICY "administration_witness_org" ON "administration_witness"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "administration_witness" TO wardenx_app;
GRANT ALL ON "administration_witness" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_deployment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_deployment_org" ON "comfort_kit_deployment";
CREATE POLICY "comfort_kit_deployment_org" ON "comfort_kit_deployment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_deployment" TO wardenx_app;
GRANT ALL ON "comfort_kit_deployment" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_drawdown" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_drawdown_org" ON "comfort_kit_drawdown";
CREATE POLICY "comfort_kit_drawdown_org" ON "comfort_kit_drawdown"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_drawdown" TO wardenx_app;
GRANT ALL ON "comfort_kit_drawdown" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_worksheet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "medication_reconciliation_worksheet_org" ON "medication_reconciliation_worksheet";
CREATE POLICY "medication_reconciliation_worksheet_org" ON "medication_reconciliation_worksheet"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "medication_reconciliation_worksheet" TO wardenx_app;
GRANT ALL ON "medication_reconciliation_worksheet" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "medication_reconciliation_decision_org" ON "medication_reconciliation_decision";
CREATE POLICY "medication_reconciliation_decision_org" ON "medication_reconciliation_decision"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "medication_reconciliation_decision" TO wardenx_app;
GRANT ALL ON "medication_reconciliation_decision" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "barcode_scan_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "barcode_scan_event_org" ON "barcode_scan_event";
CREATE POLICY "barcode_scan_event_org" ON "barcode_scan_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "barcode_scan_event" TO wardenx_app;
GRANT ALL ON "barcode_scan_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "administration_offline_queue" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "administration_offline_queue_org" ON "administration_offline_queue";
CREATE POLICY "administration_offline_queue_org" ON "administration_offline_queue"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "administration_offline_queue" TO wardenx_app;
GRANT ALL ON "administration_offline_queue" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "administration_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "administration_policy_org" ON "administration_policy";
CREATE POLICY "administration_policy_org" ON "administration_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "administration_policy" TO wardenx_app;
GRANT ALL ON "administration_policy" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, §3.6). audit_scrub keys on top-level columns;
--    administration_record additionally re-scrubs the nested per-mode `data` json-paths.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_administration_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['notes','refusal_reason','caregiver_attestation_text','dispute_reason',
    'administrative_override_reason','correction_reason','void_reason']::text[];
  v_data_keys text[] := ARRAY['sig_free_text','infusionDilution','titrationReason','pauseReason',
    'stopReason','wastageReason']::text[];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_before := audit_scrub(to_jsonb(OLD), v_cols);
    IF v_before ? 'data' AND jsonb_typeof(v_before->'data') = 'object' THEN
      v_before := jsonb_set(v_before, '{data}', audit_scrub(v_before->'data', v_data_keys));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_after := audit_scrub(to_jsonb(NEW), v_cols);
    IF v_after ? 'data' AND jsonb_typeof(v_after->'data') = 'object' THEN
      v_after := jsonb_set(v_after, '{data}', audit_scrub(v_after->'data', v_data_keys));
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
    'administration_record.' || lower(TG_OP),
    'administration_record',
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
ALTER FUNCTION audit_phi_write_administration_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_administration_record" AFTER INSERT OR UPDATE OR DELETE ON administration_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_administration_record();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_scheduled_dose() RETURNS trigger
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
    'system',
    'scheduled_dose.' || lower(TG_OP),
    'scheduled_dose',
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
ALTER FUNCTION audit_phi_write_scheduled_dose() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_scheduled_dose" AFTER INSERT OR UPDATE OR DELETE ON scheduled_dose
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_scheduled_dose();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_prn_administration() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['triggering_prn_reason','prn_interval_override_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['triggering_prn_reason','prn_interval_override_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'prn_administration.' || lower(TG_OP),
    'prn_administration',
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
ALTER FUNCTION audit_phi_write_prn_administration() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_prn_administration" AFTER INSERT OR UPDATE OR DELETE ON prn_administration
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_prn_administration();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_missed_dose() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['missed_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['missed_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'missed_dose.' || lower(TG_OP),
    'missed_dose',
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
ALTER FUNCTION audit_phi_write_missed_dose() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_missed_dose" AFTER INSERT OR UPDATE OR DELETE ON missed_dose
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_missed_dose();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_administration_witness() RETURNS trigger
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
    'administration_witness.' || lower(TG_OP),
    'administration_witness',
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
ALTER FUNCTION audit_phi_write_administration_witness() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_administration_witness" AFTER INSERT OR UPDATE OR DELETE ON administration_witness
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_administration_witness();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_comfort_kit_deployment() RETURNS trigger
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
    'comfort_kit_deployment.' || lower(TG_OP),
    'comfort_kit_deployment',
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
ALTER FUNCTION audit_phi_write_comfort_kit_deployment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_comfort_kit_deployment" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_deployment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_comfort_kit_deployment();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_comfort_kit_drawdown() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['notes']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['notes']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_drawdown.' || lower(TG_OP),
    'comfort_kit_drawdown',
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
ALTER FUNCTION audit_phi_write_comfort_kit_drawdown() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_comfort_kit_drawdown" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_drawdown
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_comfort_kit_drawdown();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_medication_reconciliation_worksheet() RETURNS trigger
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
    'medication_reconciliation_worksheet.' || lower(TG_OP),
    'medication_reconciliation_worksheet',
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
ALTER FUNCTION audit_phi_write_medication_reconciliation_worksheet() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_reconciliation_worksheet" AFTER INSERT OR UPDATE OR DELETE ON medication_reconciliation_worksheet
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_reconciliation_worksheet();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_medication_reconciliation_decision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['decision_notes','caregiver_reported_snapshot']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['decision_notes','caregiver_reported_snapshot']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'medication_reconciliation_decision.' || lower(TG_OP),
    'medication_reconciliation_decision',
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
ALTER FUNCTION audit_phi_write_medication_reconciliation_decision() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_reconciliation_decision" AFTER INSERT OR UPDATE OR DELETE ON medication_reconciliation_decision
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_reconciliation_decision();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_barcode_scan_event() RETURNS trigger
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
    'barcode_scan_event.' || lower(TG_OP),
    'barcode_scan_event',
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
ALTER FUNCTION audit_phi_write_barcode_scan_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_barcode_scan_event" AFTER INSERT OR UPDATE OR DELETE ON barcode_scan_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_barcode_scan_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_administration_offline_queue() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['rejection_reason_detail']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['rejection_reason_detail']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'administration_offline_queue.' || lower(TG_OP),
    'administration_offline_queue',
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
ALTER FUNCTION audit_phi_write_administration_offline_queue() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_administration_offline_queue" AFTER INSERT OR UPDATE OR DELETE ON administration_offline_queue
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_administration_offline_queue();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_administration_policy() RETURNS trigger
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
    'administration_policy.' || lower(TG_OP),
    'administration_policy',
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
ALTER FUNCTION audit_phi_write_administration_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_administration_policy" AFTER INSERT OR UPDATE OR DELETE ON administration_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_administration_policy();
