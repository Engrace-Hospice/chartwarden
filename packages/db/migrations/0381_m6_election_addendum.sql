-- M6 — `election_addendum`: the 42 CFR 418.24(c) "Patient Notification of Hospice Non-Covered Items, Services, and
-- Drugs" (FY2027 hospice final rule CMS-1851-F; mandatory for every election effective on or after 2026-10-01).
-- ADR-0015 D1 and the M6 spec have named this table since v0.2; it was never built.
--
-- VERSIONED per admission: version 1 is the initial addendum (due within 5 calendar days of the election's effective
-- date, 418.24(d)(1)); each plan-of-care change that affects the determinations adds a version (due within 3 calendar
-- days, (d)(2)). Lifecycle (enforced in code by state-machines/election-addendum.ts and here by the CHECKs):
--   draft → furnished → signed | refused | signature_not_required
--   draft → not_required                        (the patient died / revoked / was discharged before it was furnished)
-- A furnished version is never edited; the next version supersedes it (`superseded_by_id`).
--
-- PHI-bearing → three tenancy columns, FORCEd RLS, write-audit trigger whose denylist drops every PHI / free-text
-- column (patient name, record number, diagnoses, items, explanations, representative, refusal and exemption notes).
-- No DELETE grant: an addendum is part of the medical record (418.24(c)(9), (d)(3), (d)(4)).
-- Idempotent.
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_status" AS ENUM(
    'draft', 'furnished', 'signed', 'refused', 'signature_not_required', 'not_required');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_trigger" AS ENUM('initial', 'poc_change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_furnish_method" AS ENUM('paper', 'electronic_with_paper_copy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_signer_kind" AS ENUM('beneficiary', 'representative');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_exemption_reason" AS ENUM('death', 'revocation', 'discharge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "election_addendum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"election_statement_id" uuid,
	"version_number" integer NOT NULL,
	"trigger" "election_addendum_trigger" NOT NULL,
	"trigger_cause" text,
	"triggered_at" timestamp with time zone NOT NULL,
	"status" "election_addendum_status" DEFAULT 'draft' NOT NULL,
	"hospice_name" text,
	"patient_name" text,
	"medical_record_number" text,
	"terminal_diagnosis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_diagnoses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_non_covered_items" boolean DEFAULT false NOT NULL,
	"clinical_explanation" text,
	"guideline_references" text,
	"due_at" timestamp with time zone,
	"furnished_at" timestamp with time zone,
	"furnish_method" "election_addendum_furnish_method",
	"furnished_by_user_id" uuid,
	"signed_at" timestamp with time zone,
	"signer_kind" "election_addendum_signer_kind",
	"representative_name" text,
	"representative_relationship" text,
	"refused_at" timestamp with time zone,
	"refusal_reason" text,
	"acknowledgement_recorded_by_user_id" uuid,
	"signature_not_required_reason" "election_addendum_exemption_reason",
	"signature_not_required_note" text,
	"signature_not_required_at" timestamp with time zone,
	"document_id" uuid,
	"superseded_by_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "election_addendum_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_admission_id_admission_id_fk"
		FOREIGN KEY ("admission_id") REFERENCES "admission"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_election_statement_id_election_statement_id_fk"
		FOREIGN KEY ("election_statement_id") REFERENCES "election_statement"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_furnished_by_user_id_user_id_fk"
		FOREIGN KEY ("furnished_by_user_id") REFERENCES "user"("id") ON DELETE set null,
	CONSTRAINT "election_addendum_ack_recorded_by_user_id_user_id_fk"
		FOREIGN KEY ("acknowledgement_recorded_by_user_id") REFERENCES "user"("id") ON DELETE set null,
	CONSTRAINT "election_addendum_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null,
	CONSTRAINT "election_addendum_superseded_by_id_fk"
		FOREIGN KEY ("superseded_by_id") REFERENCES "election_addendum"("id") ON DELETE restrict,
	CONSTRAINT "election_addendum_version_positive_chk" CHECK ("version_number" >= 1),
	CONSTRAINT "election_addendum_items_array_chk" CHECK (jsonb_typeof("items") = 'array'),
	CONSTRAINT "election_addendum_dx_array_chk"
		CHECK (jsonb_typeof("terminal_diagnosis") = 'array' AND jsonb_typeof("related_diagnoses") = 'array'),
	-- "No non-covered items" is a documented determination, so it cannot coexist with a non-empty list.
	CONSTRAINT "election_addendum_none_or_items_chk"
		CHECK (NOT ("no_non_covered_items" AND jsonb_array_length("items") > 0)),
	-- (c)(10): every version past draft (other than one never furnished) carries the date it was furnished.
	CONSTRAINT "election_addendum_furnished_shape_chk"
		CHECK (("status" IN ('draft', 'not_required')) OR ("furnished_at" IS NOT NULL AND "furnish_method" IS NOT NULL)),
	-- (c)(9): a signature names who signed; a representative signature names the representative.
	CONSTRAINT "election_addendum_signed_shape_chk"
		CHECK ("status" <> 'signed' OR ("signed_at" IS NOT NULL AND "signer_kind" IS NOT NULL
			AND ("signer_kind" = 'beneficiary' OR length(coalesce("representative_name", '')) > 0))),
	-- (c)(9): a refusal records the reason on the addendum.
	CONSTRAINT "election_addendum_refused_shape_chk"
		CHECK ("status" <> 'refused' OR ("refused_at" IS NOT NULL AND length(coalesce("refusal_reason", '')) > 0)),
	-- (d)(3)/(d)(4): an exemption records why.
	CONSTRAINT "election_addendum_exemption_shape_chk"
		CHECK ("status" NOT IN ('signature_not_required', 'not_required')
			OR ("signature_not_required_reason" IS NOT NULL AND "signature_not_required_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "election_addendum_admission_version_uq"
	ON "election_addendum" ("admission_id", "version_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "election_addendum_one_draft_uq"
	ON "election_addendum" ("admission_id") WHERE "status" = 'draft';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_org_admission_idx"
	ON "election_addendum" ("organization_id", "admission_id", "version_number");--> statement-breakpoint
ALTER TABLE "election_addendum" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "election_addendum" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "election_addendum_org" ON "election_addendum"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE: an addendum (and its refusal / exemption notes) is part of the medical record.
GRANT SELECT, INSERT, UPDATE ON "election_addendum" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "election_addendum" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_election_addendum() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_name', 'medical_record_number', 'terminal_diagnosis', 'related_diagnoses', 'items', 'clinical_explanation', 'guideline_references', 'representative_name', 'representative_relationship', 'refusal_reason', 'signature_not_required_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_name', 'medical_record_number', 'terminal_diagnosis', 'related_diagnoses', 'items', 'clinical_explanation', 'guideline_references', 'representative_name', 'representative_relationship', 'refusal_reason', 'signature_not_required_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'election_addendum.' || lower(TG_OP),
    'election_addendum',
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
ALTER FUNCTION audit_phi_write_election_addendum() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_election_addendum" ON election_addendum;--> statement-breakpoint
CREATE TRIGGER "trg_audit_election_addendum" AFTER INSERT OR UPDATE OR DELETE ON election_addendum
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_election_addendum();
