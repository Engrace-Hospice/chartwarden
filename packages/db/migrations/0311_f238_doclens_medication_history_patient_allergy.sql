-- F-238 (meds + allergies) — the two chart stores a reviewer-attested DocLens referral line can land in.
--
-- 1. medication_history_record (M12 D10) gains a second source, `doclens_intake`: a medication line from a
--    referral fax AS THE REVIEWER ATTESTED IT, verbatim in `drug_name` (never parsed, never coded by AI;
--    strength / dose_form / sig / rxnorm stay NULL). It is reconciliation evidence only — D10 "never
--    auto-linked to medication_order" — and NOTHING writes a `medication_order` from it (M12 D12 /
--    AI Governance §2.1.1). `pull_id` / `source_event_id` become NOT NULL only for `dosespot_medhx`
--    (the source-shape CHECK); a DocLens row instead carries the extraction provenance ids, the attesting
--    reviewer, and `line_key` (deterministic dedupe key: one row per patient per line, a repeat fax is
--    reported back as `duplicate`, not written twice). The §5.5 W-MR-05 reconciliation decision lands on
--    the row (`reconciliation_decision` / `reconciled_*`, set together or not at all).
--
-- 2. patient_allergy (M5; architecture §10.6.6 "Allergies → Module 5 → Allergy (linked to Patient)") — the
--    patient's allergy list. DocLens rows arrive `unverified` (source `intake_extraction`); a clinician
--    verifies or marks entered-in-error. Never deleted. Three-column tenancy, ENABLE + FORCE RLS on the
--    canonical `app.org_id` predicate, SELECT/INSERT/UPDATE to wardenx_app (no DELETE), M4 write-audit
--    trigger with `allergen_text`, `reaction`, `entered_in_error_reason` denylisted.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards).

-- The pgEnum mirror (`packages/db/src/enums.ts`); the column itself is text + CHECK (the 0303 shape).
ALTER TYPE "medication_history_source" ADD VALUE IF NOT EXISTS 'doclens_intake';--> statement-breakpoint

-- ── 1. medication_history_record ──────────────────────────────────────────────────────────────────────
ALTER TABLE "medication_history_record" ALTER COLUMN "pull_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_history_record" ALTER COLUMN "source_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_history_record"
  ADD COLUMN IF NOT EXISTS "source_extraction_candidate_id" uuid,
  ADD COLUMN IF NOT EXISTS "source_extraction_decision_id" uuid,
  ADD COLUMN IF NOT EXISTS "source_document_id" uuid,
  ADD COLUMN IF NOT EXISTS "source_page" integer,
  ADD COLUMN IF NOT EXISTS "attested_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "attested_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "line_key" text,
  ADD COLUMN IF NOT EXISTS "reconciliation_decision" text,
  ADD COLUMN IF NOT EXISTS "reconciled_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "medication_history_record" DROP CONSTRAINT IF EXISTS "medication_history_record_source_chk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "medication_history_record" ADD CONSTRAINT "medication_history_record_source_chk"
    CHECK ("source" IN ('dosespot_medhx', 'doclens_intake'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "medication_history_record" ADD CONSTRAINT "medication_history_record_source_shape_chk" CHECK (
    ("source" = 'dosespot_medhx' AND "pull_id" IS NOT NULL AND "source_event_id" IS NOT NULL)
    OR (
      "source" = 'doclens_intake'
      AND "pull_id" IS NULL
      AND "source_extraction_candidate_id" IS NOT NULL
      AND "source_extraction_decision_id" IS NOT NULL
      AND "source_document_id" IS NOT NULL
      AND "attested_by_membership_id" IS NOT NULL
      AND "attested_at" IS NOT NULL
      AND "line_key" IS NOT NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "medication_history_record" ADD CONSTRAINT "medication_history_record_reconciliation_chk" CHECK (
    ("reconciliation_decision" IS NULL OR "reconciliation_decision" IN ('carry_forward', 'discontinue', 'document_only'))
    AND ("reconciliation_decision" IS NULL) = ("reconciled_at" IS NULL)
    AND ("reconciliation_decision" IS NULL) = ("reconciled_by_membership_id" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Idempotent per source candidate (a redelivered commit finds its own row), and one DocLens row per
-- (patient, line) — the dedupe the consumer reports as `duplicate`.
CREATE UNIQUE INDEX IF NOT EXISTS "medication_history_record_source_candidate_uq"
  ON "medication_history_record" ("organization_id", "source_extraction_candidate_id")
  WHERE "source_extraction_candidate_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medication_history_record_doclens_key_uq"
  ON "medication_history_record" ("organization_id", "patient_id", "line_key")
  WHERE "source" = 'doclens_intake';--> statement-breakpoint

-- ── 2. patient_allergy ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "patient_allergy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"allergen_text" text NOT NULL,
	"allergen_key" text NOT NULL,
	"reaction" text,
	"severity" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"source" text NOT NULL,
	"source_extraction_candidate_id" uuid,
	"source_extraction_decision_id" uuid,
	"source_extraction_commit_id" uuid,
	"source_document_id" uuid,
	"source_page" integer,
	"reported_by_membership_id" uuid NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by_membership_id" uuid,
	"verified_at" timestamp with time zone,
	"entered_in_error_by_membership_id" uuid,
	"entered_in_error_at" timestamp with time zone,
	"entered_in_error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_allergy_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "patient_allergy_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "patient_allergy_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "patient_allergy_patient_id_patient_id_fk"
		FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict,
	CONSTRAINT "patient_allergy_status_chk"
		CHECK ("verification_status" IN ('unverified', 'verified', 'entered_in_error')),
	CONSTRAINT "patient_allergy_source_chk" CHECK ("source" IN ('intake_extraction', 'clinician_entry')),
	CONSTRAINT "patient_allergy_severity_chk"
		CHECK ("severity" IS NULL OR "severity" IN ('mild', 'moderate', 'severe', 'unknown')),
	-- An intake row always cites the extraction it came from.
	CONSTRAINT "patient_allergy_intake_provenance_chk" CHECK (
		"source" <> 'intake_extraction' OR (
			"source_extraction_candidate_id" IS NOT NULL AND "source_extraction_decision_id" IS NOT NULL
			AND "source_extraction_commit_id" IS NOT NULL AND "source_document_id" IS NOT NULL
		)
	),
	-- Status and its attribution move together: verified ⇔ verifier; entered_in_error ⇔ who + why.
	CONSTRAINT "patient_allergy_verified_shape_chk" CHECK (
		("verified_at" IS NULL) = ("verified_by_membership_id" IS NULL)
		AND ("verification_status" <> 'verified' OR "verified_at" IS NOT NULL)
	),
	CONSTRAINT "patient_allergy_eie_shape_chk" CHECK (
		("verification_status" = 'entered_in_error') = (
			"entered_in_error_at" IS NOT NULL AND "entered_in_error_by_membership_id" IS NOT NULL
			AND "entered_in_error_reason" IS NOT NULL
		)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_allergy_patient_idx"
	ON "patient_allergy" ("organization_id", "patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_allergy_source_candidate_uq"
	ON "patient_allergy" ("organization_id", "source_extraction_candidate_id")
	WHERE "source_extraction_candidate_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_allergy_active_key_uq"
	ON "patient_allergy" ("organization_id", "patient_id", "allergen_key")
	WHERE "verification_status" <> 'entered_in_error';--> statement-breakpoint

ALTER TABLE "patient_allergy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_allergy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "patient_allergy_org" ON "patient_allergy"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_allergy" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_allergy" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_patient_allergy() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['allergen_text','reaction','entered_in_error_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['allergen_text','reaction','entered_in_error_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_allergy.' || lower(TG_OP),
    'patient_allergy',
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
ALTER FUNCTION audit_phi_write_patient_allergy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_patient_allergy" ON patient_allergy;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_allergy" AFTER INSERT OR UPDATE OR DELETE ON patient_allergy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_allergy();
