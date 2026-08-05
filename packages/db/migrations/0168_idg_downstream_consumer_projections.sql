-- M11/M12/M16 live consumers for M14's idg.decision_recorded command contract.
CREATE TABLE IF NOT EXISTS "order_idg_decision_application" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "idg_decision_id" uuid NOT NULL,
  "order_ids" jsonb NOT NULL,
  "applied_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_idg_decision_application_org_decision_unique"
  ON "order_idg_decision_application" ("organization_id", "idg_decision_id");--> statement-breakpoint
ALTER TABLE "order_idg_decision_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_idg_decision_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "order_idg_decision_application_org" ON "order_idg_decision_application"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "order_idg_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "order_idg_decision_application" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "order_idg_decision_application_audit"
  AFTER INSERT OR UPDATE OR DELETE ON order_idg_decision_application
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

ALTER TABLE "medication_order" ADD COLUMN IF NOT EXISTS "triggering_idg_decision_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_order_triggering_idg_decision_idx"
  ON "medication_order" ("organization_id", "triggering_idg_decision_id")
  WHERE "triggering_idg_decision_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "medication_order_idg_decision_application" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "idg_decision_id" uuid NOT NULL,
  "medication_order_ids" jsonb NOT NULL,
  "applied_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "med_order_idg_application_org_decision_unique"
  ON "medication_order_idg_decision_application" ("organization_id", "idg_decision_id");--> statement-breakpoint
ALTER TABLE "medication_order_idg_decision_application" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medication_order_idg_decision_application" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "medication_order_idg_decision_application_org"
  ON "medication_order_idg_decision_application" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "medication_order_idg_decision_application" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "medication_order_idg_decision_application" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "medication_order_idg_decision_application_audit"
  AFTER INSERT OR UPDATE OR DELETE ON medication_order_idg_decision_application
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bereavement_idg_risk_flag" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "idg_decision_id" uuid NOT NULL,
  "idg_meeting_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "risk_level" text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  "rationale_text" text NOT NULL,
  "recorded_by_membership_id" uuid NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  "status" text DEFAULT 'pending_assessment' NOT NULL
    CHECK (status IN ('pending_assessment', 'assessed')),
  "assessed_risk_score_id" uuid,
  "assessed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "bereavement_idg_risk_flag_assessment_consistency" CHECK (
    (status = 'pending_assessment' AND assessed_risk_score_id IS NULL AND assessed_at IS NULL)
    OR (status = 'assessed' AND assessed_risk_score_id IS NOT NULL AND assessed_at IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bereavement_idg_risk_flag_org_decision_unique"
  ON "bereavement_idg_risk_flag" ("organization_id", "idg_decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bereavement_idg_risk_flag_pending_patient_idx"
  ON "bereavement_idg_risk_flag" ("organization_id", "patient_id", "status");--> statement-breakpoint
ALTER TABLE "bereavement_idg_risk_flag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_idg_risk_flag" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_idg_risk_flag_org" ON "bereavement_idg_risk_flag"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_idg_risk_flag" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "bereavement_idg_risk_flag" TO wardenx_admin;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_idg_risk_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_org uuid;
  v_rid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY['rationale_text']); v_after := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY['rationale_text']);
    v_after := audit_scrub(to_jsonb(NEW), ARRAY['rationale_text']);
  ELSE
    v_before := NULL; v_after := audit_scrub(to_jsonb(NEW), ARRAY['rationale_text']);
  END IF;
  v_org := NULLIF(COALESCE(v_after->>'organization_id', v_before->>'organization_id'), '')::uuid;
  v_rid := NULLIF(COALESCE(v_after->>'id', v_before->>'id'), '')::uuid;
  INSERT INTO audit_event (
    organization_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, retention_class
  ) VALUES (
    v_org, 'system', TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, v_rid,
    'db-trigger', 'success', 'info', v_before, v_after, 'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "bereavement_idg_risk_flag_audit"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_idg_risk_flag
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_idg_risk_flag();
