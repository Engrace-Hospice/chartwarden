-- compat: expand
-- ADR-0109 D10 / blueprint section 3 (PR 3) - the M16 GRIEF LIBRARY: `bereavement_library_item`, M16's metadata over an M22 document
-- (aggregate type `bereavement_library_item`, migration 1392) that families see in the bereaved portal (owner decision 2026-11-05: uploaded via M22,
-- portal-only).
--   * ORG-LEVEL (agency content; no patient, plan or contact) - the 1374 / 1390 precedent. It names no person, so the destruction role needs nothing.
--   * `document_id` / `transcript_document_id` are LOGICAL uuids to M22 documents (cross-module FK policy); M16 checks at registration, through the
--     M22 seam, that each is an active, org-level `bereavement_library_item` document, and `document_id` is UNIQUE per tenant (one item per file).
--     `kind` and `mime_type` are copied from the document's active version. A transcript is a PDF (for a video).
--   * Lifecycle draft -> published -> archived (and back to draft); only `published` items reach the portal. `sort_order` orders the portal list.
--   * ENABLE + FORCE RLS on app.org_id, SELECT/INSERT/UPDATE to the app role (nothing deletes), the 1200 PHI audit trigger (the summary is agency
--     prose and is scrubbed), FK and org indexes. Catalog rows: `bereavement.library.read` / `.manage` (bereavement oversight).
CREATE TABLE "bereavement_library_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "title" text NOT NULL,
  "summary" text,
  "category" text NOT NULL,
  "kind" text NOT NULL,
  "document_id" uuid NOT NULL,
  "mime_type" text NOT NULL,
  "transcript_document_id" uuid,
  "status" text DEFAULT 'draft' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "published_at" timestamptz,
  "created_by_membership_id" uuid NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_library_title_chk" CHECK (char_length("title") BETWEEN 1 AND 160),
  CONSTRAINT "berv_library_summary_chk" CHECK ("summary" IS NULL OR char_length("summary") <= 1000),
  CONSTRAINT "berv_library_category_chk" CHECK ("category" IN ('understanding_grief', 'coping', 'children_and_teens', 'holidays_and_anniversaries', 'practical_matters', 'other')),
  CONSTRAINT "berv_library_kind_chk" CHECK ("kind" IN ('pdf', 'video', 'other')),
  CONSTRAINT "berv_library_status_chk" CHECK ("status" IN ('draft', 'published', 'archived')),
  CONSTRAINT "berv_library_sort_chk" CHECK ("sort_order" BETWEEN 0 AND 10000),
  CONSTRAINT "berv_library_published_chk" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL),
  CONSTRAINT "berv_library_transcript_chk" CHECK ("transcript_document_id" IS NULL OR "transcript_document_id" <> "document_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_library_org_document_uniq" ON "bereavement_library_item" ("organization_id", "document_id");--> statement-breakpoint
CREATE INDEX "berv_library_org_status_idx" ON "bereavement_library_item" ("organization_id", "status", "sort_order", "title");--> statement-breakpoint

ALTER TABLE "bereavement_library_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_library_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_library_item_org_isolation" ON "bereavement_library_item"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_library_item" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_library_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['summary']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_library_item() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_library_item"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_library_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_library_item('bereavement_library_item');--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('bereavement.library.read', 'bereavement_library_item', 'read', 'clinical', 'org_scope_bereavement_oversight', ''),
  ('bereavement.library.manage', 'bereavement_library_item', 'manage', 'clinical', 'org_scope_bereavement_oversight', '')
ON CONFLICT ("key") DO NOTHING;
