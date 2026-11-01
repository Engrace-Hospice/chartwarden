-- compat: expand
-- #908/#910 -- critical_lab_result (M11): one row per CRITICAL (HH/LL) lab observation the lab-results applier saw, so a
-- critical result is never silently dropped and a superseded one is visibly marked, not deleted.
--   * disposition 'paged'                 -- bound to an order; the M36 critical-lab alert pages the people.
--   * disposition 'quarantined_no_order'  -- bound to a patient but to NO order: held in this visible queue with a clock
--     (`respond_by`); the caseload RN is paged at once and the hospice doctor when `respond_by` lapses (`escalated_at`).
--   * `order_unsigned` -- the order carried no signature yet (e.g. a verbal order); the alert also reaches its drafter
--     and the hospice doctor.
--   * `superseded_at` / `superseded_by_observation_id` -- a later NON-critical observation of the same test on the same
--     order withdrew the critical value; the earlier alert is kept.
-- Ids, a LOINC code and a flag only: no result value, no name. `order_record_id` is a plain uuid (order_record is
-- partitioned: the order_discontinuation precedent). UNIQUE (organization_id, observation_id) makes a redelivery a no-op.
-- Three-column tenancy, ENABLE + FORCE RLS on the canonical `app.org_id` predicate, M4 write-audit trigger. The app role
-- may INSERT and UPDATE only the escalation / supersede columns; nothing deletes a row. Idempotent.

CREATE TABLE IF NOT EXISTS "critical_lab_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"order_record_id" uuid,
	"loinc_code" text NOT NULL,
	"critical_flag" text NOT NULL,
	"disposition" text NOT NULL,
	"order_unsigned" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"respond_by" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by_observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "critical_lab_result_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "critical_lab_result_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "critical_lab_result_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "critical_lab_result_patient_id_patient_id_fk"
		FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict,
	CONSTRAINT "critical_lab_result_disposition_chk"
		CHECK ("disposition" IN ('paged', 'quarantined_no_order')),
	CONSTRAINT "critical_lab_result_flag_chk" CHECK ("critical_flag" IN ('HH', 'LL')),
	-- A quarantined result is, by definition, the one with no order -- and only it carries a response clock.
	CONSTRAINT "critical_lab_result_quarantine_shape_chk" CHECK (
		("disposition" = 'quarantined_no_order') = ("order_record_id" IS NULL)
		AND ("disposition" = 'quarantined_no_order') = ("respond_by" IS NOT NULL)
	),
	CONSTRAINT "critical_lab_result_superseded_shape_chk" CHECK (
		("superseded_at" IS NULL) = ("superseded_by_observation_id" IS NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "critical_lab_result_observation_uq"
	ON "critical_lab_result" ("organization_id", "observation_id");--> statement-breakpoint
-- The open-quarantine scan (escalation sweep + the visible queue).
CREATE INDEX IF NOT EXISTS "critical_lab_result_quarantine_idx"
	ON "critical_lab_result" ("organization_id", "respond_by")
	WHERE "disposition" = 'quarantined_no_order';--> statement-breakpoint
-- The supersede lookup: open criticals of one test on one order.
CREATE INDEX IF NOT EXISTS "critical_lab_result_order_idx"
	ON "critical_lab_result" ("organization_id", "order_record_id", "loinc_code")
	WHERE "order_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "critical_lab_result_patient_idx"
	ON "critical_lab_result" ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "critical_lab_result_provider_entity_idx"
	ON "critical_lab_result" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "critical_lab_result_location_idx"
	ON "critical_lab_result" ("location_id");--> statement-breakpoint

ALTER TABLE "critical_lab_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "critical_lab_result" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "critical_lab_result_org" ON "critical_lab_result"
    FOR ALL TO chartwarden_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT ON "critical_lab_result" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("escalated_at", "superseded_at", "superseded_by_observation_id", "updated_at")
	ON "critical_lab_result" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "critical_lab_result" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_critical_lab_result() RETURNS trigger
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
    'critical_lab_result.' || lower(TG_OP),
    'critical_lab_result',
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
ALTER FUNCTION audit_phi_write_critical_lab_result() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_critical_lab_result" ON critical_lab_result;--> statement-breakpoint
CREATE TRIGGER "trg_audit_critical_lab_result" AFTER INSERT OR UPDATE OR DELETE ON critical_lab_result
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_critical_lab_result();
