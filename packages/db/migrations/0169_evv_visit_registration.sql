-- M18-owned idempotent projection of M17's m17.visit.published contract.
CREATE TABLE IF NOT EXISTS "evv_visit_registration" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE restrict,
  "location_id" uuid NOT NULL REFERENCES "location"("id") ON DELETE restrict,
  "visit_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "assigned_membership_id" uuid NOT NULL,
  "assigned_discipline" text NOT NULL,
  "service_type_code" text NOT NULL,
  "patient_address_id" uuid,
  "external_facility_id" uuid,
  "scheduled_started_at" timestamptz NOT NULL,
  "scheduled_ended_at" timestamptz NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "evv_visit_registration_window_valid"
    CHECK (scheduled_ended_at > scheduled_started_at)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evv_visit_registration_org_visit_unique"
  ON "evv_visit_registration" ("organization_id", "visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_visit_registration_patient_schedule_idx"
  ON "evv_visit_registration" ("organization_id", "patient_id", "scheduled_started_at");--> statement-breakpoint
ALTER TABLE "evv_visit_registration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evv_visit_registration" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "evv_visit_registration_org" ON "evv_visit_registration"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "evv_visit_registration" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "evv_visit_registration" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "evv_visit_registration_audit"
  AFTER INSERT OR UPDATE OR DELETE ON evv_visit_registration
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
