-- M22 — DocLens: records attached to a PROSPECT, checked to be that person, and movable when misfiled (F-238).
--
-- A hospice referral rarely arrives complete: older PCP and hospital records are requested and come back by
-- fax days later. They must land on the same prospect, and a fax carrying another patient's page must never
-- reach a chart.
--
-- 1. intake_upload_batch.referral_id — the M6 referral the records are for (app-validated through the M6
--    ReferralReader seam; no cross-module FK). A batch filed against a referral adopts the referral's patient
--    once M6 resolves one. Plus `identity_status`, the worst per-document identity verdict (below), or
--    `no_target` while there is neither a patient nor a referral to compare with.
-- 2. classified_page.identity_* — per DOCUMENT (the splitter's segment): the two-identifier check of the
--    document's own name + DOB against the patient (or the referral's name/DOB at receipt):
--    match | possible | mismatch | unverified, the disagreeing FIELD names (never values), and a reviewer's
--    resolution: `same_patient` (e.g. a married name) or `other_patient` (that document's fields are
--    rejected and never written back). The resolution reason may quote names → audit-denylisted.
-- 3. intake_batch_relink — append-only history of moving a batch to another patient / referral before its
--    review completes (who, when, from → to, why). PHI (patient ids; the reason) → three tenancy columns,
--    FORCEd RLS, write-audit trigger with the reason denylisted.
-- Idempotent.
ALTER TABLE "intake_upload_batch"
  ADD COLUMN IF NOT EXISTS "referral_id" uuid,
  ADD COLUMN IF NOT EXISTS "identity_status" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_identity_status_check"
    CHECK ("identity_status" IS NULL OR "identity_status" IN ('match', 'possible', 'mismatch', 'unverified', 'no_target'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_batch_org_referral_idx"
  ON "intake_upload_batch" ("organization_id", "referral_id") WHERE "referral_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "classified_page"
  ADD COLUMN IF NOT EXISTS "identity_status" text,
  ADD COLUMN IF NOT EXISTS "identity_disagreeing" jsonb,
  ADD COLUMN IF NOT EXISTS "identity_resolution" text,
  ADD COLUMN IF NOT EXISTS "identity_resolved_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "identity_resolved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "identity_resolution_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classified_page" ADD CONSTRAINT "classified_page_identity_status_check"
    CHECK ("identity_status" IS NULL OR "identity_status" IN ('match', 'possible', 'mismatch', 'unverified'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classified_page" ADD CONSTRAINT "classified_page_identity_resolution_shape"
    CHECK (
      ("identity_resolution" IS NULL AND "identity_resolved_by_membership_id" IS NULL AND "identity_resolved_at" IS NULL)
      OR ("identity_resolution" IN ('same_patient', 'other_patient')
          AND "identity_resolved_by_membership_id" IS NOT NULL AND "identity_resolved_at" IS NOT NULL
          AND "identity_resolution_reason" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intake_batch_relink" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"intake_upload_batch_id" uuid NOT NULL,
	"from_patient_id" uuid,
	"from_referral_id" uuid,
	"to_referral_id" uuid,
	"reason" text NOT NULL,
	"relinked_by_membership_id" uuid NOT NULL,
	"relinked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	CONSTRAINT "intake_batch_relink_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id"),
	CONSTRAINT "intake_batch_relink_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id"),
	CONSTRAINT "intake_batch_relink_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "location"("id"),
	CONSTRAINT "intake_batch_relink_batch_fk"
		FOREIGN KEY ("intake_upload_batch_id") REFERENCES "intake_upload_batch"("id"),
	CONSTRAINT "intake_batch_relink_target_chk" CHECK ("patient_id" IS NOT NULL OR "to_referral_id" IS NOT NULL),
	CONSTRAINT "intake_batch_relink_reason_chk" CHECK (length(btrim("reason")) >= 5)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_batch_relink_batch_idx"
	ON "intake_batch_relink" ("organization_id", "intake_upload_batch_id", "relinked_at");--> statement-breakpoint
ALTER TABLE "intake_batch_relink" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_batch_relink" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "intake_batch_relink_org" ON "intake_batch_relink"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Append-only: history is never edited.
GRANT SELECT, INSERT ON "intake_batch_relink" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "intake_batch_relink" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_intake_batch_relink() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intake_batch_relink.' || lower(TG_OP),
    'intake_batch_relink',
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
ALTER FUNCTION audit_phi_write_intake_batch_relink() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_intake_batch_relink" ON intake_batch_relink;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intake_batch_relink" AFTER INSERT OR UPDATE OR DELETE ON intake_batch_relink
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intake_batch_relink();--> statement-breakpoint

-- classified_page's audit trigger: the resolution reason joins the denylist (0309 had document_title).
CREATE OR REPLACE FUNCTION audit_phi_write_classified_page() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['document_title', 'identity_resolution_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['document_title', 'identity_resolution_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'classified_page.' || lower(TG_OP),
    'classified_page',
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
ALTER FUNCTION audit_phi_write_classified_page() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_classified_page" ON classified_page;--> statement-breakpoint
CREATE TRIGGER "trg_audit_classified_page" AFTER INSERT OR UPDATE OR DELETE ON classified_page
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_classified_page();
