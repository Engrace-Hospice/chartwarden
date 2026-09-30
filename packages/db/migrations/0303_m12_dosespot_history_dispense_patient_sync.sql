-- M12 — the DoseSpot vendor-boundary persistence tables (F-230, #248): the four tables the two
-- vendor-gated pairs (`m14 <- m12.medication_history_pulled`, `m21 <- m12.medication_order.dispensed_at_pharmacy`)
-- need on OUR side of the boundary, so that the moment per-tenant DoseSpot credentials bind, the pull/ingest and
-- pharmacy-dispense paths have somewhere real to write. NOTHING here is populated by anything but a real ingested
-- vendor payload — no seed, no backfill, no default row.
--
--   1. dosespot_patient_sync      — §2.6 the patient -> DoseSpot-side patient id mapping. Before this table the
--                                   `medhx_fetch` worker had no id to pull history FOR (vendor-boundary.ts:
--                                   `M12DosespotPatientIdUnbound`). Written only by a successful `upsertPatient`.
--   2. medication_history_pull    — one ledger row per ingested MedHx pull (idempotent on the sync-queue job id).
--                                   It exists so "pulled, DoseSpot returned zero entries" (M12 §5.5 edge: the IDG
--                                   packet shows 'No external medication history available') is distinguishable
--                                   from "never pulled" — the latter must NEVER be rendered as 'none'.
--   3. medication_history_record  — §2.8 one row per external MedHx entry (PHI). NOT auto-linked to a
--                                   medication_order (§2.8 "Why no auto-link").
--   4. medication_order_dispense  — §4.4 one row per `Dispensed`/`PickedUp` ScriptStatusUpdate webhook, idempotent
--                                   on the vendor event id (§7.4.4).
--
-- RLS: canonical app.org_id predicate, ENABLE + FORCE together (F-087). Grants: SELECT/INSERT/UPDATE to
-- wardenx_app, never DELETE (the M12 eraser runs as the admin role). M4 write-audit trigger on every table;
-- medication_history_record denylists `drug_name` + `sig_text` (clinical free text, §7.6 precedent).
CREATE TABLE IF NOT EXISTS "dosespot_patient_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"last_dosespot_patient_id" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_outcome" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dosespot_patient_sync_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "dosespot_patient_sync_outcome_chk" CHECK ("last_sync_outcome" IN ('success', 'failed')),
	CONSTRAINT "dosespot_patient_sync_success_has_id_chk"
		CHECK ("last_sync_outcome" <> 'success' OR "last_dosespot_patient_id" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dosespot_patient_sync_patient_uq"
	ON "dosespot_patient_sync" ("organization_id", "patient_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "medication_history_pull" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"source" text DEFAULT 'dosespot_medhx' NOT NULL,
	"source_job_id" uuid NOT NULL,
	"dosespot_patient_id" text NOT NULL,
	"total_returned" integer NOT NULL,
	"rows_created" integer NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medication_history_pull_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medication_history_pull_source_chk" CHECK ("source" IN ('dosespot_medhx')),
	CONSTRAINT "medication_history_pull_counts_chk"
		CHECK ("total_returned" >= 0 AND "rows_created" >= 0 AND "rows_created" <= "total_returned")
);--> statement-breakpoint
-- Idempotency: one ledger row per (org, sync-queue job) — a redelivered/re-run job is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "medication_history_pull_job_uq"
	ON "medication_history_pull" ("organization_id", "source_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_history_pull_patient_ix"
	ON "medication_history_pull" ("organization_id", "patient_id", "pulled_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "medication_history_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"pull_id" uuid NOT NULL,
	"source" text DEFAULT 'dosespot_medhx' NOT NULL,
	"source_event_id" uuid NOT NULL,
	"line_index" integer NOT NULL,
	"rxnorm_rxcui" text,
	"ndc" text,
	"drug_name" text NOT NULL,
	"strength" text,
	"dose_form" text,
	"sig_text" text,
	"prescribed_at" timestamp with time zone,
	"last_fill_date" text,
	"fill_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_pharmacy" text,
	"pharmacy_ncpdp" text,
	"prescriber_npi" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medication_history_record_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medication_history_record_pull_id_fk"
		FOREIGN KEY ("pull_id") REFERENCES "public"."medication_history_pull"("id") ON DELETE restrict,
	CONSTRAINT "medication_history_record_source_chk" CHECK ("source" IN ('dosespot_medhx'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medication_history_record_line_uq"
	ON "medication_history_record" ("organization_id", "pull_id", "line_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_history_record_patient_ix"
	ON "medication_history_record" ("organization_id", "patient_id", "created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "medication_order_dispense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"dosespot_prescription_id" text NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"dosespot_event_id" text NOT NULL,
	"script_status" text NOT NULL,
	"dispensed_at" timestamp with time zone NOT NULL,
	"fill_number" integer,
	"dispensing_pharmacy_mdm_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medication_order_dispense_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medication_order_dispense_webhook_event_id_fk"
		FOREIGN KEY ("webhook_event_id") REFERENCES "public"."dosespot_webhook_event"("id") ON DELETE restrict,
	CONSTRAINT "medication_order_dispense_status_chk" CHECK ("script_status" IN ('Dispensed', 'PickedUp'))
);--> statement-breakpoint
-- §7.4.4 idempotency: one dispense row per (org, vendor event id).
CREATE UNIQUE INDEX IF NOT EXISTS "medication_order_dispense_event_uq"
	ON "medication_order_dispense" ("organization_id", "dosespot_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_order_dispense_order_ix"
	ON "medication_order_dispense" ("organization_id", "medication_order_id");--> statement-breakpoint

-- RLS (ENABLE + FORCE together, F-087), policies, grants.
ALTER TABLE "dosespot_patient_sync" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dosespot_patient_sync" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "dosespot_patient_sync_org" ON "dosespot_patient_sync"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "dosespot_patient_sync" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dosespot_patient_sync" TO wardenx_admin;--> statement-breakpoint

ALTER TABLE "medication_history_pull" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medication_history_pull" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medication_history_pull_org" ON "medication_history_pull"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medication_history_pull" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medication_history_pull" TO wardenx_admin;--> statement-breakpoint

ALTER TABLE "medication_history_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medication_history_record" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medication_history_record_org" ON "medication_history_record"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medication_history_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medication_history_record" TO wardenx_admin;--> statement-breakpoint

ALTER TABLE "medication_order_dispense" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medication_order_dispense" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medication_order_dispense_org" ON "medication_order_dispense"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "medication_order_dispense" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medication_order_dispense" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0253 shape; `audit_scrub` redacts the denylisted top-level keys).
CREATE OR REPLACE FUNCTION audit_phi_write_dosespot_patient_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'dosespot_patient_sync.' || lower(TG_OP),
    'dosespot_patient_sync',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dosespot_patient_sync() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dosespot_patient_sync" AFTER INSERT OR UPDATE OR DELETE ON dosespot_patient_sync
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dosespot_patient_sync();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_medication_history_pull() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'medication_history_pull.' || lower(TG_OP),
    'medication_history_pull',
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
ALTER FUNCTION audit_phi_write_medication_history_pull() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_history_pull" AFTER INSERT OR UPDATE OR DELETE ON medication_history_pull
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_history_pull();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_medication_history_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['drug_name','sig_text'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'medication_history_record.' || lower(TG_OP),
    'medication_history_record',
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
ALTER FUNCTION audit_phi_write_medication_history_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_history_record" AFTER INSERT OR UPDATE OR DELETE ON medication_history_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_history_record();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_medication_order_dispense() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'medication_order_dispense.' || lower(TG_OP),
    'medication_order_dispense',
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
ALTER FUNCTION audit_phi_write_medication_order_dispense() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medication_order_dispense" AFTER INSERT OR UPDATE OR DELETE ON medication_order_dispense
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medication_order_dispense();
