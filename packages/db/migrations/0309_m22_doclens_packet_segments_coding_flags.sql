-- M22 — DocLens complex packets (F-238): the fax-packet splitter's document segments and the deterministic
-- ICD-10-CM coding checks on extracted diagnoses.
--
-- classified_page — one row per DOCUMENT the splitter found in the fax (it already carried a page range):
--   · `document_title` — the document's own header ("DISCHARGE SUMMARY", "SALEM NEUROLOGY & MEMORY CENTER").
--     A header can name a care setting that is itself sensitive (an addiction-treatment program is 42 CFR
--     Part 2 information), so it is audit-denylisted.
--   · `document_date` — the document's own date (discharge/exam/visit date, never the DOB): the date a code
--     written in it is judged against.
--   · `duplicate_of_page` — set when the page is a re-sent copy of an earlier page; never extracted twice.
--   · `segment_boundary` — why the splitter started a document here (first_page | new_header |
--     type_change | duplicate); no PHI.
--
-- extraction_candidate.coding_flags_cipher — the coding checks for a diagnosis candidate (code not valid on
-- the document's date, retired since, manifestation code, unacceptable hospice principal, a combination
-- or more specific code the packet supports, OCR repair…) as a tenant-DEK envelope: a flag names codes,
-- and a code on a named patient's record is PHI (an F10–F19 code is Part 2). Audit-denylisted.
-- Idempotent.
ALTER TABLE "classified_page"
  ADD COLUMN IF NOT EXISTS "document_title" text,
  ADD COLUMN IF NOT EXISTS "document_date" date,
  ADD COLUMN IF NOT EXISTS "duplicate_of_page" integer,
  ADD COLUMN IF NOT EXISTS "segment_boundary" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classified_page" ADD CONSTRAINT "classified_page_segment_boundary_check"
    CHECK ("segment_boundary" IS NULL OR "segment_boundary" IN ('first_page', 'new_header', 'type_change', 'duplicate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "extraction_candidate"
  ADD COLUMN IF NOT EXISTS "coding_flags_cipher" text;--> statement-breakpoint
-- The two write-audit triggers (0049) gain the new PHI columns in their §3.6 denylists.
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
    THEN audit_scrub(to_jsonb(OLD), ARRAY['document_title']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['document_title']::text[]) ELSE NULL END;
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
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_classified_page();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_extraction_candidate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['coding_flags_cipher', 'source_bounding_box', 'value_cipher', 'value_text', 'vision_disagreement']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['coding_flags_cipher', 'source_bounding_box', 'value_cipher', 'value_text', 'vision_disagreement']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'extraction_candidate.' || lower(TG_OP),
    'extraction_candidate',
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
ALTER FUNCTION audit_phi_write_extraction_candidate() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_extraction_candidate" ON extraction_candidate;--> statement-breakpoint
CREATE TRIGGER "trg_audit_extraction_candidate" AFTER INSERT OR UPDATE OR DELETE ON extraction_candidate
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_extraction_candidate();
