-- M9 reassessment-due ledger (GAP-181).
--
-- The `assessment.cadence` / `reassessment-due-scan` cron (§4.8, daily) used to compute which (patient,
-- scale) pairs are past their reassessment cadence and then only `console.log` the count — "no chart-banner
-- cache seam exists". This table IS that seam, in M9's OWN schema (no cross-module write): one row per
-- (organization, patient, scale_type) holding the next due instant derived from the last capture and the
-- effective cadence (the CoP 42 CFR 418.54(d) 15-day floor, tenant-tightenable via
-- `scale_policy.reassessment_cadence_overrides`, never loosened). The chart banner and the M36 alert path read
-- it; the cron is its only writer (system actor, `withOrgContext`), so a recorded capture moves `due_at`
-- forward and the banner clears on the next tick.
--
-- Overdue is a SOFT state (spec §2.7): this table never blocks recording.
CREATE TABLE IF NOT EXISTS "assessment_reassessment_due" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"scale_type" "scale_type" NOT NULL,
	"last_captured_at" timestamp with time zone NOT NULL,
	"cadence_days" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"overdue_since" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_reassessment_due_status_chk" CHECK ("status" IN ('open', 'overdue', 'closed')),
	CONSTRAINT "assessment_reassessment_due_cadence_chk" CHECK ("cadence_days" >= 1)
);--> statement-breakpoint
ALTER TABLE "assessment_reassessment_due" ADD CONSTRAINT "assessment_reassessment_due_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_reassessment_due" ADD CONSTRAINT "assessment_reassessment_due_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_reassessment_due" ADD CONSTRAINT "assessment_reassessment_due_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assessment_reassessment_due_patient_scale_uq" ON "assessment_reassessment_due" USING btree ("organization_id","patient_id","scale_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessment_reassessment_due_status_due_idx" ON "assessment_reassessment_due" USING btree ("organization_id","status","due_at");--> statement-breakpoint
ALTER TABLE "assessment_reassessment_due" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_reassessment_due" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "assessment_reassessment_due_org" ON "assessment_reassessment_due";--> statement-breakpoint
CREATE POLICY "assessment_reassessment_due_org" ON "assessment_reassessment_due"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "assessment_reassessment_due" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "assessment_reassessment_due" TO wardenx_admin;--> statement-breakpoint
GRANT SELECT, DELETE ON "assessment_reassessment_due" TO wardenx_destruction;   --> statement-breakpoint
DROP POLICY IF EXISTS "assessment_reassessment_due_destruction" ON "assessment_reassessment_due";--> statement-breakpoint
CREATE POLICY "assessment_reassessment_due_destruction" ON "assessment_reassessment_due"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_assessment_reassessment_due() RETURNS trigger
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
    'assessment_reassessment_due.' || lower(TG_OP),
    'assessment_reassessment_due',
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
ALTER FUNCTION audit_phi_write_assessment_reassessment_due() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_assessment_reassessment_due" AFTER INSERT OR UPDATE OR DELETE ON assessment_reassessment_due
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_assessment_reassessment_due();
