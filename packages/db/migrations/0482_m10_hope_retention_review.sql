-- M10 HOPE retention review ledger (GAP-181).
--
-- `hope.retention` was a declared queue with no worker: HOPE retention was documented, not implemented. The
-- monthly `hope-retention-scan` now evaluates every patient's HOPE record against the retention horizons the
-- architecture and M10 spec set (architecture OPEN-021 / M10 spec §3 retention class):
--   * a record with a SUBMITTED assessment is held 10 years from the last iQIES transmission (CMS
--     `extended_for_cms`), and never less than the standard horizon below;
--   * every other HOPE record is held 7 years from the last effective date (HIPAA 45 CFR 164.316(b)(2) /
--     164.530(j) six-year floor, 42 CFR 418.104 five-year-after-discharge floor — the architecture's 7-year
--     default is the longest of the three);
--   * a tenant/state override can only LENGTHEN the horizon, never shorten it;
--   * NEVER eligible while an active legal hold covers the patient, an iQIES submission item is still rejected /
--     blocked / unmatched on a live assessment, or a correction draft is pending.
-- The scan only FLAGS. Destruction itself stays on the M4 destruction-certificate pathway (a human-approved
-- certificate invoking the registered `hope_record` eraser, which re-checks the CMS 10-year rule) — the scan
-- never deletes clinical rows. This table records what it found; one row per (organization, patient).
CREATE TABLE IF NOT EXISTS "hope_retention_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"basis" text NOT NULL,
	"anchor_at" timestamp with time zone NOT NULL,
	"retention_years" integer NOT NULL,
	"eligible_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"blockers" text[] DEFAULT '{}'::text[] NOT NULL,
	"flagged_at" timestamp with time zone,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hope_retention_review_basis_chk" CHECK ("basis" IN ('submitted_cms_10y', 'standard_7y')),
	CONSTRAINT "hope_retention_review_status_chk" CHECK ("status" IN ('eligible', 'blocked', 'cleared')),
	CONSTRAINT "hope_retention_review_years_chk" CHECK ("retention_years" >= 7)
);--> statement-breakpoint
ALTER TABLE "hope_retention_review" ADD CONSTRAINT "hope_retention_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_retention_review" ADD CONSTRAINT "hope_retention_review_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_retention_review" ADD CONSTRAINT "hope_retention_review_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hope_retention_review_patient_uq" ON "hope_retention_review" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hope_retention_review_status_idx" ON "hope_retention_review" USING btree ("organization_id","status","eligible_at");--> statement-breakpoint
ALTER TABLE "hope_retention_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_retention_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "hope_retention_review_org" ON "hope_retention_review";--> statement-breakpoint
CREATE POLICY "hope_retention_review_org" ON "hope_retention_review"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hope_retention_review" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "hope_retention_review" TO wardenx_admin;--> statement-breakpoint
GRANT SELECT, DELETE ON "hope_retention_review" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "hope_retention_review_destruction" ON "hope_retention_review";--> statement-breakpoint
CREATE POLICY "hope_retention_review_destruction" ON "hope_retention_review"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_hope_retention_review() RETURNS trigger
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
    'hope_retention_review.' || lower(TG_OP),
    'hope_retention_review',
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
ALTER FUNCTION audit_phi_write_hope_retention_review() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_retention_review" AFTER INSERT OR UPDATE OR DELETE ON hope_retention_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_retention_review();
