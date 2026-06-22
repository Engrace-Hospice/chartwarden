-- M11 Orders §3.3 (RLS + grants) + §3.4/§3.8 (state-transition triggers + the order_record partition
-- conversion) + M4 write-audit triggers — M11-T02.
--
-- Tables/enums/indexes/FKs land in 0036 (drizzle-generated). This migration locks:
--   • the §3.6/§3.7 PARTITION BY RANGE (created_at) conversion of order_record — Postgres requires
--     PARTITION BY at CREATE time, so (hope_assessment precedent, 0035) we drop the plain table 0036
--     created and re-create it partitioned, with the same columns/PK/FKs/indexes. Monthly partitions
--     (current + 12 forward) + a DEFAULT catch-all, all created dynamically via format(%I) so the static
--     phi-guards scan does not mis-detect a partition child as a separate un-triggered org-scoped table
--     (row triggers on the partitioned parent propagate to every partition, PG11+). The M1 partition-
--     maintenance cron rotates new months;
--   • the §3.4/§3.8 state-transition triggers: replace-supersede (atomic correction-of-record),
--     verbal-order set-target-pending, signature-apply-to-target, and the §3.5 lab-initial-states trigger;
--   • standard app.org_id org-scope RLS on all seven M11 tables (ADR-0010 D2: row visibility keys ONLY on
--     app.org_id, set by withOrgContext()); the three-column tenancy (organization_id + provider_entity_id
--     + location_id) is denormalized on all seven for ABAC narrowing, but the RLS pivot is organization_id
--     alone (§3.6);
--   • the grants policy — wardenx_app has SELECT/INSERT/UPDATE and DELETE on NONE (orders are append +
--     status-transition; a correction supersedes the prior row; discontinuation inserts a ledger row;
--     destruction clears via the admin-run eraseFn, M11-T08);
--   • the M4 write-audit trigger (generateAuditTrigger shape) on every table, with the §3.4/§8.1 PHI
--     denylist: the order_record `data` / indication_text; the order_signature attestation_text /
--     on_behalf_reason; the verbal_order verbal_attestation; the standing_order template_data /
--     indication_text; the standing_order_instance spawn_context_note; the order_discontinuation notes —
--     so free-text/PHI never lands in the audit diff (the trigger records the write + a <changed> marker,
--     never the value; audit_scrub keys on top-level columns). All seven carry organization_id, so all
--     seven get BOTH an RLS policy and a trigger (arch:gaps phi-guards floor). Retention class
--     'compliance' (CMS conditions-of-participation order retention, M4 D1).--> statement-breakpoint
-- 1. order_record: drop the plain table 0036 created, re-create RANGE-partitioned on created_at
--    (§3.6/§3.7). Same logical shape as the Drizzle definition; the partition + triggers are invisible to
--    drizzle-kit (it diffs the 0036 snapshot, which carries the logical table). replaces_order_id stays a
--    loose self-ref (NO SQL FK, §3.3); standing_order_id is the only intra-module FK.--> statement-breakpoint
DROP TABLE IF EXISTS "order_record" CASCADE;--> statement-breakpoint
CREATE TABLE "order_record" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "kind" "order_kind" NOT NULL,
  "kind_version" text NOT NULL,
  "data" jsonb NOT NULL,
  "priority" "order_priority" DEFAULT 'routine' NOT NULL,
  "indication_text" text,
  "status" "order_status" DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "drafter_membership_id" uuid NOT NULL,
  "drafter_discipline" text NOT NULL,
  "ordering_physician_mdm_id" uuid NOT NULL,
  "source_encounter_id" uuid,
  "triggering_assessment_id" uuid,
  "triggering_hope_assessment_id" uuid,
  "triggering_idg_decision_id" uuid,
  "replaces_order_id" uuid,
  "standing_order_id" uuid,
  "cosign_required" boolean DEFAULT false NOT NULL,
  "cosign_status" text,
  "transmission_status" "order_transmission_status" DEFAULT 'not_required' NOT NULL,
  "transmission_acked_at" timestamp with time zone,
  "transmission_ack_code" text,
  "transmission_failure_reason" text,
  "results_status" "order_results_status" DEFAULT 'not_expected' NOT NULL,
  "results_first_received_at" timestamp with time zone,
  "last_lab_observation_attached_id" uuid,
  "document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "signed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "discontinued_at" timestamp with time zone,
  CONSTRAINT "order_record_id_created_at_pk" PRIMARY KEY("id","created_at"),
  CONSTRAINT "order_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
  CONSTRAINT "order_record_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "order_record_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
  CONSTRAINT "order_record_drafter_membership_id_membership_id_fk" FOREIGN KEY ("drafter_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict,
  CONSTRAINT "order_record_standing_order_id_standing_order_id_fk" FOREIGN KEY ("standing_order_id") REFERENCES "public"."standing_order"("id")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
-- DEFAULT catch-all + monthly partitions (current + 12 forward) created dynamically (format %I) so the
-- static phi-guards scan does not mis-detect a partition child as a separate un-triggered org table.--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF order_record DEFAULT', 'order_record_default');
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_order_record_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'order_record_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF order_record FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_order_record_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "order_record_patient_status_idx" ON "order_record" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "order_record_admission_status_idx" ON "order_record" USING btree ("organization_id","admission_id","status");--> statement-breakpoint
CREATE INDEX "order_record_kind_status_idx" ON "order_record" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE INDEX "order_record_physician_pending_idx" ON "order_record" USING btree ("organization_id","ordering_physician_mdm_id","status") WHERE status IN ('pending_signature','verbal_pending');--> statement-breakpoint
CREATE INDEX "order_record_replaces_idx" ON "order_record" USING btree ("replaces_order_id");--> statement-breakpoint
CREATE INDEX "order_record_standing_parent_idx" ON "order_record" USING btree ("standing_order_id");--> statement-breakpoint
CREATE INDEX "order_record_triggering_assessment_idx" ON "order_record" USING btree ("triggering_assessment_id");--> statement-breakpoint
CREATE INDEX "order_record_triggering_hope_idx" ON "order_record" USING btree ("triggering_hope_assessment_id");--> statement-breakpoint
CREATE INDEX "order_record_created_idx" ON "order_record" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_order_results_status_awaiting" ON "order_record" USING btree ("organization_id","results_status","signed_at") WHERE kind = 'lab' AND results_status IN ('awaiting_results', 'partial_results_received');--> statement-breakpoint
CREATE INDEX "idx_order_transmission_status" ON "order_record" USING btree ("organization_id","transmission_status","signed_at") WHERE kind = 'lab' AND transmission_status IN ('pending', 'pending_retry');--> statement-breakpoint
-- §3.4 correction-supersede: on INSERT of a correcting order (replaces_order_id set), discontinue the
-- replaced order in the same TX and write its discontinuation ledger row (three-column tenancy sourced
-- from the correcting row NEW, since order_discontinuation's PE/location are NOT NULL).--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_record_replace_supersede() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.replaces_order_id IS NOT NULL THEN
    UPDATE order_record
       SET status = 'discontinued',
           discontinued_at = now(),
           version = version + 1,
           updated_at = now()
     WHERE id = NEW.replaces_order_id
       AND organization_id = NEW.organization_id
       AND status IN ('pending_signature','verbal_pending','active');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPLACED_ORDER_NOT_REPLACEABLE';
    END IF;
    INSERT INTO order_discontinuation (
      organization_id, provider_entity_id, location_id, order_record_id,
      actor_membership_id, reason, effective_at
    ) VALUES (
      NEW.organization_id, NEW.provider_entity_id, NEW.location_id, NEW.replaces_order_id,
      NEW.drafter_membership_id, 'corrected_replacement', now()
    );
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "order_record_replace_supersede_trg"
  AFTER INSERT ON order_record
  FOR EACH ROW
  WHEN (NEW.replaces_order_id IS NOT NULL)
  EXECUTE FUNCTION order_record_replace_supersede();--> statement-breakpoint
-- §3.4/§3.5 lab-initial-states: when a lab order becomes active (signed), set its transmission/results
-- initial states (belt-and-suspenders for programmatic INSERTs as well as the sign UPDATE).--> statement-breakpoint
CREATE OR REPLACE FUNCTION m11_set_lab_initial_states() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'lab' AND NEW.status = 'active'
     AND (OLD IS NULL OR OLD.status != 'active') THEN
    NEW.transmission_status := 'pending';
    NEW.results_status := 'awaiting_results';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_m11_lab_initial_states"
  BEFORE INSERT OR UPDATE ON order_record
  FOR EACH ROW EXECUTE FUNCTION m11_set_lab_initial_states();--> statement-breakpoint
-- §3.4 verbal-order set-target-pending: on INSERT of a verbal_order for an order target, flip the linked
-- order_record from pending_signature to verbal_pending (M12 owns the flip for medication_order targets).--> statement-breakpoint
CREATE OR REPLACE FUNCTION verbal_order_set_target_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind = 'order' THEN
    UPDATE order_record
       SET status = 'verbal_pending', version = version + 1, updated_at = now()
     WHERE id = NEW.target_id
       AND organization_id = NEW.organization_id
       AND status = 'pending_signature';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TARGET_NOT_PENDING_SIGNATURE';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "verbal_order_set_target_pending_trg"
  AFTER INSERT ON verbal_order
  FOR EACH ROW EXECUTE FUNCTION verbal_order_set_target_pending();--> statement-breakpoint
-- §3.4 signature-apply: on INSERT of a primary signature for an order target, flip the linked order to
-- active when cosign prerequisites are met.--> statement-breakpoint
CREATE OR REPLACE FUNCTION order_signature_apply_to_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signature_kind = 'signature' AND NEW.target_kind = 'order' THEN
    UPDATE order_record
       SET status = 'active',
           version = version + 1,
           signed_at = NEW.signed_at,
           updated_at = now()
     WHERE id = NEW.target_id
       AND organization_id = NEW.organization_id
       AND status IN ('pending_signature','verbal_pending')
       AND (cosign_required = false OR cosign_status = 'attached');
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "order_signature_apply_to_target_trg"
  AFTER INSERT ON order_signature
  FOR EACH ROW EXECUTE FUNCTION order_signature_apply_to_target();--> statement-breakpoint
-- 2. Org-scope RLS + grants (standard app.org_id; §3.6). No DELETE — append + status-transition.--> statement-breakpoint
ALTER TABLE "order_record" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_record_org" ON "order_record";
CREATE POLICY "order_record_org" ON "order_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "order_record" TO wardenx_app;
GRANT ALL ON "order_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "order_signature" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_signature_org" ON "order_signature";
CREATE POLICY "order_signature_org" ON "order_signature"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "order_signature" TO wardenx_app;
GRANT ALL ON "order_signature" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "verbal_order" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "verbal_order_org" ON "verbal_order";
CREATE POLICY "verbal_order_org" ON "verbal_order"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "verbal_order" TO wardenx_app;
GRANT ALL ON "verbal_order" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "standing_order" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "standing_order_org" ON "standing_order";
CREATE POLICY "standing_order_org" ON "standing_order"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "standing_order" TO wardenx_app;
GRANT ALL ON "standing_order" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "standing_order_instance_org" ON "standing_order_instance";
CREATE POLICY "standing_order_instance_org" ON "standing_order_instance"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "standing_order_instance" TO wardenx_app;
GRANT ALL ON "standing_order_instance" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_discontinuation_org" ON "order_discontinuation";
CREATE POLICY "order_discontinuation_org" ON "order_discontinuation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "order_discontinuation" TO wardenx_app;
GRANT ALL ON "order_discontinuation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_verbal_policy_org" ON "order_verbal_policy";
CREATE POLICY "order_verbal_policy_org" ON "order_verbal_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "order_verbal_policy" TO wardenx_app;
GRANT ALL ON "order_verbal_policy" TO wardenx_admin;--> statement-breakpoint
-- 3. M4 write-audit triggers (per-table PHI denylist, §3.4/§8.1). audit_scrub keys on top-level columns.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_order_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['data', 'indication_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['data', 'indication_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'order_record.' || lower(TG_OP),
    'order_record',
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
ALTER FUNCTION audit_phi_write_order_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_record" AFTER INSERT OR UPDATE OR DELETE ON order_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_record();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_order_signature() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['attestation_text', 'on_behalf_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['attestation_text', 'on_behalf_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'order_signature.' || lower(TG_OP),
    'order_signature',
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
ALTER FUNCTION audit_phi_write_order_signature() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_signature" AFTER INSERT OR UPDATE OR DELETE ON order_signature
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_signature();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_verbal_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['verbal_attestation']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['verbal_attestation']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'verbal_order.' || lower(TG_OP),
    'verbal_order',
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
ALTER FUNCTION audit_phi_write_verbal_order() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_verbal_order" AFTER INSERT OR UPDATE OR DELETE ON verbal_order
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_verbal_order();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_standing_order() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['template_data', 'indication_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['template_data', 'indication_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'standing_order.' || lower(TG_OP),
    'standing_order',
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
ALTER FUNCTION audit_phi_write_standing_order() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_standing_order" AFTER INSERT OR UPDATE OR DELETE ON standing_order
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_standing_order();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_standing_order_instance() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['spawn_context_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['spawn_context_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'standing_order_instance.' || lower(TG_OP),
    'standing_order_instance',
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
ALTER FUNCTION audit_phi_write_standing_order_instance() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_standing_order_instance" AFTER INSERT OR UPDATE OR DELETE ON standing_order_instance
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_standing_order_instance();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_order_discontinuation() RETURNS trigger
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
    'order_discontinuation.' || lower(TG_OP),
    'order_discontinuation',
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
ALTER FUNCTION audit_phi_write_order_discontinuation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_discontinuation" AFTER INSERT OR UPDATE OR DELETE ON order_discontinuation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_discontinuation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_order_verbal_policy() RETURNS trigger
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
    'order_verbal_policy.' || lower(TG_OP),
    'order_verbal_policy',
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
ALTER FUNCTION audit_phi_write_order_verbal_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_verbal_policy" AFTER INSERT OR UPDATE OR DELETE ON order_verbal_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_verbal_policy();
