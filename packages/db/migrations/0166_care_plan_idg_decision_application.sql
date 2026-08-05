-- M7 durable IDG-decision application marker. The marker and care-plan mutations share one
-- transaction; the unique decision key is the replay/concurrency guard.
CREATE TABLE IF NOT EXISTS "care_plan_idg_decision_application" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "idg_decision_id" uuid NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "care_plan_id" uuid NOT NULL,
  "care_plan_version_id" uuid NOT NULL,
  "applied_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "care_plan_idg_application_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_application_provider_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_application_location_fk"
    FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_application_plan_fk"
    FOREIGN KEY ("care_plan_id") REFERENCES "care_plan"("id") ON DELETE restrict,
  CONSTRAINT "care_plan_idg_application_version_fk"
    FOREIGN KEY ("care_plan_version_id") REFERENCES "care_plan_version"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_plan_idg_decision_application_decision_uq"
  ON "care_plan_idg_decision_application" ("organization_id", "idg_decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_plan_idg_decision_application_plan_applied_idx"
  ON "care_plan_idg_decision_application" ("care_plan_id", "applied_at");--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_plan_idg_decision_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "care_plan_idg_decision_application_org" ON "care_plan_idg_decision_application";--> statement-breakpoint
CREATE POLICY "care_plan_idg_decision_application_org" ON "care_plan_idg_decision_application"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "care_plan_idg_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "care_plan_idg_decision_application" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "care_plan_idg_decision_application_audit"
  AFTER INSERT OR UPDATE OR DELETE ON care_plan_idg_decision_application
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
