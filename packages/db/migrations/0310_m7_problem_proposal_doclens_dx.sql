-- M7 — `problem_proposal` (F-238 dx-writeback): DocLens-extracted, reviewer-attested diagnoses waiting
-- for a clinician. M22 publishes `m22.extraction.diagnosis_commit_requested`; M7's
-- `m7.extraction-diagnosis-writeback` consumer lands each diagnosis here as `status = 'pending'` and
-- replies `m7.problem.draft_created_from_extraction`. A clinician ACCEPTS (choosing `kind` — the document's
-- "principal" label never becomes `terminal`) which inserts the real `problem` row (`source =
-- 'intake_extraction'`) and links it, or DISMISSES.
--
-- WHY A SEPARATE TABLE, not a new `problem_status`: every reader of `problem` (M23 claim sequencing via
-- the claim-diagnoses gate, the IDG packet cover, HOPE, the portal digest, the encounter picker, version
-- state snapshots, M38 code-usage remediation) would otherwise have to learn to exclude drafts, and a
-- reader that forgot would surface an unaccepted AI-extracted diagnosis as a charted one (AI Governance
-- v0.2 §2.1.1). Here that is impossible by construction, and `problem.kind` stays NOT NULL with no
-- placeholder value.
--
-- Idempotency: UNIQUE (org, source_extraction_commit_id, source_item_key) — a redelivered commit finds its
-- row. Dedupe: at most one PENDING proposal per (org, patient, dedupe_key) — a second batch repeating a
-- pending diagnosis reports the existing proposal instead of creating another. An ACTIVE problem with the
-- same code is FLAGGED (`duplicate_of_problem_id`), never merged.
--
-- RLS pivots on organization_id alone (canonical `app.org_id`, ENABLED + FORCED). The app role gets
-- SELECT/INSERT/UPDATE (no DELETE — the care-plan tables are append-only for wardenx_app, 0029); the
-- destruction role gets SELECT/DELETE for M7's `care_plan_record` eraser. Idempotent.

DO $$ BEGIN
  CREATE TYPE "public"."problem_proposal_status" AS ENUM('pending', 'accepted', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."problem_proposal_icd10_validation" AS ENUM('valid', 'not_valid_as_of', 'unvalidated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."problem_proposal_document_role" AS ENUM('principal', 'secondary', 'history', 'unspecified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "problem_proposal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "care_plan_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "description" text NOT NULL,
  "icd10_code" text,
  "icd10_source" text,
  "icd10_validation" "problem_proposal_icd10_validation",
  "document_role" "problem_proposal_document_role" DEFAULT 'unspecified' NOT NULL,
  "sud_related" boolean DEFAULT false NOT NULL,
  "status" "problem_proposal_status" DEFAULT 'pending' NOT NULL,
  "dedupe_key" text NOT NULL,
  "source_extraction_commit_id" uuid NOT NULL,
  "source_item_key" text NOT NULL,
  "source_intake_batch_id" uuid NOT NULL,
  "attested_by_membership_id" uuid,
  "duplicate_of_problem_id" uuid,
  "accepted_problem_id" uuid,
  "decided_by_membership_id" uuid,
  "decided_at" timestamp with time zone,
  "dismiss_reason" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "problem_proposal_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_care_plan_id_care_plan_id_fk"
    FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plan"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_attested_by_membership_id_membership_id_fk"
    FOREIGN KEY ("attested_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "problem_proposal_duplicate_of_problem_id_problem_id_fk"
    FOREIGN KEY ("duplicate_of_problem_id") REFERENCES "public"."problem"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_accepted_problem_id_problem_id_fk"
    FOREIGN KEY ("accepted_problem_id") REFERENCES "public"."problem"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "problem_proposal_decided_by_membership_id_membership_id_fk"
    FOREIGN KEY ("decided_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "problem_proposal_decision_shape" CHECK (
    (status = 'pending' AND decided_by_membership_id IS NULL AND decided_at IS NULL AND accepted_problem_id IS NULL)
    OR (status = 'accepted' AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL AND accepted_problem_id IS NOT NULL)
    OR (status = 'dismissed' AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL AND accepted_problem_id IS NULL)
  ),
  CONSTRAINT "problem_proposal_code_shape" CHECK (
    (icd10_code IS NULL AND icd10_source IS NULL AND icd10_validation IS NULL)
    OR (icd10_code IS NOT NULL AND icd10_source IN ('document', 'reviewer_edit') AND icd10_validation IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "problem_proposal_source_item_uq"
  ON "problem_proposal" ("organization_id", "source_extraction_commit_id", "source_item_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "problem_proposal_pending_dedupe_uq"
  ON "problem_proposal" ("organization_id", "patient_id", "dedupe_key") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "problem_proposal_plan_status_idx"
  ON "problem_proposal" ("organization_id", "care_plan_id", "status");--> statement-breakpoint

ALTER TABLE "problem_proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "problem_proposal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "problem_proposal_org" ON "problem_proposal";--> statement-breakpoint
CREATE POLICY "problem_proposal_org" ON "problem_proposal"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "problem_proposal" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "problem_proposal" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger; the free-text diagnosis description and dismissal reason never enter the diff.
CREATE OR REPLACE FUNCTION audit_phi_write_problem_proposal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['description', 'dismiss_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['description', 'dismiss_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'problem_proposal.' || lower(TG_OP),
    'problem_proposal',
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
ALTER FUNCTION audit_phi_write_problem_proposal() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_problem_proposal" ON "problem_proposal";--> statement-breakpoint
CREATE TRIGGER "trg_audit_problem_proposal" AFTER INSERT OR UPDATE OR DELETE ON problem_proposal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_problem_proposal();--> statement-breakpoint

-- Patient destruction: M7's `care_plan_record` eraser deletes proposals before the problems they point at.
GRANT SELECT, DELETE ON "problem_proposal" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "problem_proposal_destruction" ON "problem_proposal";--> statement-breakpoint
CREATE POLICY "problem_proposal_destruction" ON "problem_proposal"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
