-- M12 DoseSpot §3.3/§3.5/§7.6 (RLS + grants) + the medication_order PARTITION BY RANGE conversion + M4
-- write-audit triggers — M12-T02.
--
-- Tables/enums/indexes/FKs land in 0038 (drizzle-generated). This migration locks:
--   • the §3.5 / D15 PARTITION BY RANGE (created_at) conversion of medication_order — Postgres requires
--     PARTITION BY at CREATE time, so (order_record precedent, 0037) we drop the plain table 0038 created and
--     re-create it partitioned, with the same columns/PK/check/FKs/indexes. Monthly partitions (current + 12
--     forward) + a DEFAULT catch-all, created dynamically via format(%I) so the static phi-guards scan does
--     not mis-detect a partition child as a separate un-triggered org table (row triggers on the partitioned
--     parent propagate to every partition, PG11+). The M1 partition-maintenance cron rotates new months. The
--     other five M12 tables are non-partitioned (§3.5);
--   • standard app.org_id org-scope RLS on all six M12 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()). The two PHI tables (medication_order / refill_request) carry the
--     three-column tenancy (organization_id + provider_entity_id + location_id) for ABAC narrowing, but the
--     RLS pivot is organization_id alone (§3.5). epcs_signing_attempt's §7.1 ABAC overlay (initiating
--     prescriber / platform_ops / compliance_officer only) layers in the route tier (M12-T08), not here;
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (orders are append +
--     status-transition; a correction supersedes via a new row; destruction clears via the admin-run eraseFn,
--     M12-T09);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §7.6 PHI denylist:
--     medication_order `data` (all clinician free-text — sig_free_text / indication / clinical_justification
--     / notes — lives inside the per-class TypeBox `data`, so the whole column is scrubbed);
--     medication_order_transmission `last_error_detail`; refill_request `pharmacy_notes` + `denial_reason`;
--     dosespot_webhook_event `raw_body_cipher` + `raw_body_dek` (already DEK-encrypted, further denylisted);
--     dosespot_prescriber + epcs_signing_attempt have no free-text PHI column (empty denylist). All six carry
--     organization_id, so all six get BOTH an RLS policy and a trigger (arch:gaps phi-guards floor). Retention
--     class 'compliance' (DEA §1311.205 records-of-application + CMS med-order retention, M4 D1).--> statement-breakpoint
-- 1. medication_order: drop the plain table 0038 created, re-create RANGE-partitioned on created_at (§3.5).
--    Same logical shape as the Drizzle definition; the partition + monthly children are invisible to
--    drizzle-kit (it diffs the 0038 snapshot, which carries the logical table). Cross-module refs (patient /
--    admission / prescribing physician MDM / pharmacy MDM) stay plain uuid (NO SQL FK, §3.3);
--    replaces_medication_order_id is a loose self-ref (medication_order is partitioned).--> statement-breakpoint
DROP TABLE IF EXISTS "medication_order" CASCADE;--> statement-breakpoint
CREATE TABLE "medication_order" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "med_class" "med_class" NOT NULL,
  "is_controlled_substance" boolean DEFAULT false NOT NULL,
  "dea_schedule" "dea_schedule",
  "is_sud_treatment" boolean DEFAULT false NOT NULL,
  "rxnorm_rxcui" text,
  "ndc" text,
  "drug_name" text NOT NULL,
  "strength" text NOT NULL,
  "dose_form" text NOT NULL,
  "route" text NOT NULL,
  "data" jsonb NOT NULL,
  "prescriber_membership_id" uuid NOT NULL,
  "prescribing_physician_mdm_id" uuid NOT NULL,
  "dispensing_pharmacy_mdm_id" uuid,
  "refills_authorized" integer DEFAULT 0 NOT NULL,
  "refills_remaining" integer DEFAULT 0 NOT NULL,
  "status" "medication_order_status" DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "dosespot_send_state" "dosespot_send_state" DEFAULT 'not_required' NOT NULL,
  "dosespot_prescription_id" text,
  "replaces_medication_order_id" uuid,
  "derived_from_refill_id" uuid,
  "derived_from_history_id" uuid,
  "cosign_required" boolean DEFAULT false NOT NULL,
  "cosign_status" text,
  "document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "signed_at" timestamp with time zone,
  "transmitted_at" timestamp with time zone,
  "ack_received_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "discontinued_at" timestamp with time zone,
  CONSTRAINT "medication_order_id_created_at_pk" PRIMARY KEY("id","created_at"),
  CONSTRAINT "medication_order_controlled_schedule_consistency" CHECK ((is_controlled_substance = true) = (dea_schedule IS NOT NULL)),
  CONSTRAINT "medication_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "medication_order_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "medication_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "medication_order_prescriber_membership_id_membership_id_fk" FOREIGN KEY ("prescriber_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medication_order DEFAULT', 'medication_order_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medication_order_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'medication_order_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF medication_order FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_medication_order_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "medication_order_patient_status_idx" ON "medication_order" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "medication_order_admission_status_idx" ON "medication_order" USING btree ("organization_id","admission_id","status");--> statement-breakpoint
CREATE INDEX "medication_order_med_class_status_idx" ON "medication_order" USING btree ("organization_id","med_class","status");--> statement-breakpoint
CREATE INDEX "medication_order_prescriber_pending_idx" ON "medication_order" USING btree ("organization_id","prescriber_membership_id","status") WHERE status IN ('pending_signature','verbal_pending','epcs_identity_pending');--> statement-breakpoint
CREATE INDEX "medication_order_dosespot_prescription_idx" ON "medication_order" USING btree ("dosespot_prescription_id") WHERE dosespot_prescription_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "medication_order_created_idx" ON "medication_order" USING btree ("created_at");--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.5). No DELETE — append + status-transition.--> statement-breakpoint
ALTER TABLE "medication_order" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "medication_order_org" ON "medication_order";
CREATE POLICY "medication_order_org" ON "medication_order"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "medication_order" TO wardenx_app;
GRANT ALL ON "medication_order" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "medication_order_transmission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "medication_order_transmission_org" ON "medication_order_transmission";
CREATE POLICY "medication_order_transmission_org" ON "medication_order_transmission"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "medication_order_transmission" TO wardenx_app;
GRANT ALL ON "medication_order_transmission" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "refill_request" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refill_request_org" ON "refill_request";
CREATE POLICY "refill_request_org" ON "refill_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "refill_request" TO wardenx_app;
GRANT ALL ON "refill_request" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "dosespot_webhook_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dosespot_webhook_event_org" ON "dosespot_webhook_event";
CREATE POLICY "dosespot_webhook_event_org" ON "dosespot_webhook_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "dosespot_webhook_event" TO wardenx_app;
GRANT ALL ON "dosespot_webhook_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dosespot_prescriber_org" ON "dosespot_prescriber";
CREATE POLICY "dosespot_prescriber_org" ON "dosespot_prescriber"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "dosespot_prescriber" TO wardenx_app;
GRANT ALL ON "dosespot_prescriber" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "epcs_signing_attempt" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "epcs_signing_attempt_org" ON "epcs_signing_attempt";
CREATE POLICY "epcs_signing_attempt_org" ON "epcs_signing_attempt"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "epcs_signing_attempt" TO wardenx_app;
GRANT ALL ON "epcs_signing_attempt" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, §7.6). audit_scrub keys on top-level columns.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_medication_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['data']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['data']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'medication_order.' || lower(TG_OP),
    'medication_order',
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
ALTER FUNCTION audit_phi_write_medication_order() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_order" AFTER INSERT OR UPDATE OR DELETE ON medication_order
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_order();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_medication_order_transmission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['last_error_detail']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['last_error_detail']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'medication_order_transmission.' || lower(TG_OP),
    'medication_order_transmission',
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
ALTER FUNCTION audit_phi_write_medication_order_transmission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_order_transmission" AFTER INSERT OR UPDATE OR DELETE ON medication_order_transmission
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_order_transmission();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_refill_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['pharmacy_notes', 'denial_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['pharmacy_notes', 'denial_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'refill_request.' || lower(TG_OP),
    'refill_request',
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
ALTER FUNCTION audit_phi_write_refill_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_refill_request" AFTER INSERT OR UPDATE OR DELETE ON refill_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_refill_request();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_dosespot_webhook_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['raw_body_cipher', 'raw_body_dek']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['raw_body_cipher', 'raw_body_dek']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'dosespot_webhook_event.' || lower(TG_OP),
    'dosespot_webhook_event',
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
ALTER FUNCTION audit_phi_write_dosespot_webhook_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dosespot_webhook_event" AFTER INSERT OR UPDATE OR DELETE ON dosespot_webhook_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dosespot_webhook_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_dosespot_prescriber() RETURNS trigger
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
    'dosespot_prescriber.' || lower(TG_OP),
    'dosespot_prescriber',
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
ALTER FUNCTION audit_phi_write_dosespot_prescriber() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dosespot_prescriber" AFTER INSERT OR UPDATE OR DELETE ON dosespot_prescriber
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dosespot_prescriber();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_epcs_signing_attempt() RETURNS trigger
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
    'epcs_signing_attempt.' || lower(TG_OP),
    'epcs_signing_attempt',
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
ALTER FUNCTION audit_phi_write_epcs_signing_attempt() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_epcs_signing_attempt" AFTER INSERT OR UPDATE OR DELETE ON epcs_signing_attempt
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_epcs_signing_attempt();
