-- M22 — DocLens review (F-237): the §7.4 W4 / D8 SUD-detection state of an intake batch, the page geometry
-- the side-by-side review overlay scales its boxes by, and M5's record of WHO put an interim `sud` flag on
-- a patient's privacy snapshot.
--
-- intake_upload_batch:
--   · `sud_status` — `not_detected` (default) | `detected` (the detector found 42 CFR Part 2 indicators;
--     the review cannot complete until a reviewer resolves it) | `confirmed` | `rejected` (false positive).
--   · `sud_evidence_cipher` — the per-page indicators (category, matched term, box) as a tenant-DEK envelope.
--     The matched term IS PHI ("buprenorphine" on a named patient's record), so it is never stored or
--     audited in the clear. `sud_resolution_reason` is the reviewer's free text. Both are audit-denylisted.
--   · `sud_detector_ref` — which detectors ran (`rules:v1`, `rules:v1+ai_invocation:<id>`); no PHI.
--   · `sud_resolved_by_membership_id` / `sud_resolved_at` — set together with a resolution, never otherwise.
--   · `page_geometry` — `[{page, width, height}]` in Docling's units (PDF points) — no PHI.
--
-- patient_privacy_flag_snapshot.sud_flag_origin — `m22_intake_unconfirmed` | `m22_intake_confirmed` when the
-- snapshot's `sud` flag was put there by a DocLens detection (W4 step 4/6), NULL when it came from M39 consent
-- state. A reviewer's false-positive rejection retires the flag ONLY when this says DocLens put it there.
-- Idempotent.

DO $$ BEGIN
  CREATE TYPE "public"."intake_batch_sud_status" AS ENUM('not_detected', 'detected', 'confirmed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "intake_upload_batch"
  ADD COLUMN IF NOT EXISTS "sud_status" "intake_batch_sud_status" DEFAULT 'not_detected' NOT NULL,
  ADD COLUMN IF NOT EXISTS "sud_evidence_cipher" text,
  ADD COLUMN IF NOT EXISTS "sud_detector_ref" text,
  ADD COLUMN IF NOT EXISTS "sud_resolved_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "sud_resolved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "sud_resolution_reason" text,
  ADD COLUMN IF NOT EXISTS "page_geometry" jsonb;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_sud_resolution_shape" CHECK (
    ("sud_status" IN ('confirmed', 'rejected'))
      = ("sud_resolved_at" IS NOT NULL AND "sud_resolved_by_membership_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "patient_privacy_flag_snapshot"
  ADD COLUMN IF NOT EXISTS "sud_flag_origin" text;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "patient_privacy_flag_snapshot" ADD CONSTRAINT "patient_privacy_flag_snapshot_sud_origin_check"
    CHECK ("sud_flag_origin" IS NULL OR "sud_flag_origin" IN ('m22_intake_unconfirmed', 'm22_intake_confirmed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- The intake_upload_batch write-audit trigger (0049) gains the two new PHI columns in its §3.6 denylist.
CREATE OR REPLACE FUNCTION audit_phi_write_intake_upload_batch() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['source_metadata', 'sud_evidence_cipher', 'sud_resolution_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['source_metadata', 'sud_evidence_cipher', 'sud_resolution_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intake_upload_batch.' || lower(TG_OP),
    'intake_upload_batch',
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
ALTER FUNCTION audit_phi_write_intake_upload_batch() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_intake_upload_batch" ON intake_upload_batch;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intake_upload_batch" AFTER INSERT OR UPDATE OR DELETE ON intake_upload_batch
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intake_upload_batch();
