-- compat: expand
-- ADR-0104 — patient_code_status (M5): the clinician-set code status (full code / DNR / DNR+DNI / comfort measures
-- only), an append-only history. One row per decision with who, when and a required reason; the current status is the
-- newest row that is not entered-in-error. "Not recorded" is NOT a value — it is the absence of an active row.
--
-- Append-only IN THE DATABASE: the app role holds SELECT + INSERT and UPDATE on the entered-in-error columns only, so a
-- recorded value cannot be edited (stricter than patient_allergy's whole-row UPDATE). No DELETE. Three-column tenancy,
-- ENABLE + FORCE RLS on the canonical `app.org_id` predicate, M4 write-audit trigger with `reason` and
-- `entered_in_error_reason` denylisted. `source_document_id` is a plain uuid (M22 owns `document`; no cross-module FK) —
-- the route validates it through the M22 DocumentReader seam.
--
-- Plus the `patient.edit_code_status` permission and its default grants (the 0379 pattern: wherever a tenant has created
-- the role; nothing materializes ROLE_TEMPLATES). Single source: CODE_STATUS_EDITOR_ROLE_KEYS in
-- packages/auth/src/roles/code-status-grants.ts. Idempotent.

CREATE TABLE IF NOT EXISTS "patient_code_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"code_status" text NOT NULL,
	"reason" text NOT NULL,
	"source_document_id" uuid,
	"recorded_by_membership_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entered_in_error_by_membership_id" uuid,
	"entered_in_error_at" timestamp with time zone,
	"entered_in_error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_code_status_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "patient_code_status_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "patient_code_status_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "patient_code_status_patient_id_patient_id_fk"
		FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict,
	CONSTRAINT "patient_code_status_value_chk"
		CHECK ("code_status" IN ('full_code', 'dnr', 'dnr_dni', 'comfort_measures_only')),
	CONSTRAINT "patient_code_status_reason_chk" CHECK (char_length("reason") BETWEEN 1 AND 1000),
	-- Entered-in-error attribution moves together: who + when + why, or none of them.
	CONSTRAINT "patient_code_status_eie_shape_chk" CHECK (
		("entered_in_error_at" IS NULL) = ("entered_in_error_by_membership_id" IS NULL)
		AND ("entered_in_error_at" IS NULL) = ("entered_in_error_reason" IS NULL)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_code_status_patient_idx"
	ON "patient_code_status" ("organization_id", "patient_id", "recorded_at" DESC);--> statement-breakpoint

ALTER TABLE "patient_code_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_code_status" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "patient_code_status_org" ON "patient_code_status"
    FOR ALL TO chartwarden_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT ON "patient_code_status" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("entered_in_error_by_membership_id", "entered_in_error_at", "entered_in_error_reason", "updated_at")
	ON "patient_code_status" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "patient_code_status" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_patient_code_status() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason','entered_in_error_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason','entered_in_error_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_code_status.' || lower(TG_OP),
    'patient_code_status',
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
ALTER FUNCTION audit_phi_write_patient_code_status() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_patient_code_status" ON patient_code_status;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_code_status" AFTER INSERT OR UPDATE OR DELETE ON patient_code_status
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_code_status();--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description")
VALUES ('patient.edit_code_status', 'patient', 'edit_code_status', 'clinical', 'caseload_or_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'patient.edit_code_status'
  FROM "role" r
 WHERE r."organization_id" IS NOT NULL
   AND r."key" IN (
    'rn_case_manager', 'director_of_nursing', 'md', 'physician', 'hospice_physician', 'medical_director',
    'attending_clinician', 'np', 'nurse_practitioner', 'administrator', 'org_admin'
 )
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
