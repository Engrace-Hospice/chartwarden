-- M25 ADR response packet (hospice ADR/TPE/QIC PRD, milestone 2b): the documents attached to an ADR response,
-- the checklist, the reviewer's sign-off, and the proof that the response was filed. Org-scoped (canonical
-- app.org_id RLS, FORCEd, no DELETE for the app role).
--
-- What was sent is retained twice: `adr_case.packet_manifest` (the exact document ids and checklist, frozen at
-- filing and then immutable) and the M22-rendered cover-and-index PDF filed under (adr_response_packet, case id).
-- `adr_case_document` rows are never deleted: a detach stamps `removed_at`, so the history of what was attached
-- survives. membership ids are logical (no FK), like the rest of M25.

ALTER TABLE "adr_case"
  ADD COLUMN "checklist" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "sent_to_review_by_membership_id" uuid,
  ADD COLUMN "reviewed_by_membership_id" uuid,
  ADD COLUMN "reviewed_at" timestamptz,
  ADD COLUMN "filing_channel" text CHECK ("filing_channel" IN ('mac_portal','fax','mail','esmd','other')),
  ADD COLUMN "filing_confirmation_ref" text,
  ADD COLUMN "filed_at" timestamptz,
  ADD COLUMN "filed_late" boolean NOT NULL DEFAULT false,
  ADD COLUMN "receipt_document_id" uuid,
  ADD COLUMN "packet_manifest" jsonb;--> statement-breakpoint

CREATE TABLE "adr_case_document" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "adr_case_id" uuid NOT NULL REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "document_id" uuid NOT NULL,
  "checklist_key" text CHECK ("checklist_key" IN
    ('certification_of_terminal_illness','election_statement','plan_of_care','physician_orders','visit_notes','medical_records_cover')),
  "attached_by_membership_id" uuid,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX "adr_case_document_live_unique" ON "adr_case_document" ("adr_case_id", "document_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "adr_case_document_org_ix" ON "adr_case_document" ("organization_id", "attached_at");--> statement-breakpoint

ALTER TABLE "adr_case_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adr_case_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "adr_case_document_org" ON "adr_case_document" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "adr_case_document" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("removed_at") ON "adr_case_document" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "adr_case_document" TO wardenx_admin;--> statement-breakpoint

-- The progress columns the 2a grant did not cover. Anchor, window and due date stay immutable.
GRANT UPDATE ("checklist", "sent_to_review_by_membership_id", "reviewed_by_membership_id", "reviewed_at",
  "filing_channel", "filing_confirmation_ref", "filed_at", "filed_late", "receipt_document_id", "packet_manifest")
  ON "adr_case" TO wardenx_app;--> statement-breakpoint

-- adr_case audit: the confirmation reference is free text, so it is scrubbed with adr_reference.
CREATE OR REPLACE FUNCTION audit_phi_write_adr_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['adr_reference','filing_confirmation_ref'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_case.' || lower(TG_OP), 'adr_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_adr_case_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_case_document.' || lower(TG_OP), 'adr_case_document', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_case_document() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_adr_case_document" AFTER INSERT OR UPDATE OR DELETE ON adr_case_document FOR EACH ROW EXECUTE FUNCTION audit_phi_write_adr_case_document();--> statement-breakpoint

-- What was filed is frozen: once the manifest is set, neither it nor the filing facts may change; and the
-- enclosure list of a case that has been filed may not be altered (no attach, no detach after filing).
CREATE OR REPLACE FUNCTION m25_adr_filing_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.packet_manifest IS NOT NULL AND (
       NEW.packet_manifest IS DISTINCT FROM OLD.packet_manifest
    OR NEW.filing_channel IS DISTINCT FROM OLD.filing_channel
    OR NEW.filing_confirmation_ref IS DISTINCT FROM OLD.filing_confirmation_ref
    OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
    OR NEW.filed_late IS DISTINCT FROM OLD.filed_late
    OR NEW.receipt_document_id IS DISTINCT FROM OLD.receipt_document_id
    OR NEW.reviewed_by_membership_id IS DISTINCT FROM OLD.reviewed_by_membership_id) THEN
    RAISE EXCEPTION 'M25_ADR_FILING_IMMUTABLE: adr_case % has been filed; the filing record cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- A submitted case always carries its frozen manifest and filing time: no path (including a future bug) can record
-- "submitted" without them.
ALTER TABLE "adr_case" ADD CONSTRAINT "adr_case_submitted_has_filing"
  CHECK ("state" <> 'submitted' OR ("packet_manifest" IS NOT NULL AND "filed_at" IS NOT NULL));--> statement-breakpoint
CREATE TRIGGER "trg_adr_filing_immutable" BEFORE UPDATE ON adr_case FOR EACH ROW EXECUTE FUNCTION m25_adr_filing_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m25_adr_document_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_manifest jsonb;
BEGIN
  SELECT packet_manifest INTO v_manifest FROM adr_case WHERE id = COALESCE(NEW.adr_case_id, OLD.adr_case_id);
  IF v_manifest IS NOT NULL THEN
    RAISE EXCEPTION 'M25_ADR_PACKET_FROZEN: the packet for adr_case % was filed; its enclosures cannot change', COALESCE(NEW.adr_case_id, OLD.adr_case_id);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_adr_document_frozen" BEFORE INSERT OR UPDATE ON adr_case_document FOR EACH ROW EXECUTE FUNCTION m25_adr_document_frozen();--> statement-breakpoint

-- adr.review: sign off a packet (a person other than whoever sent it to review). adr.submit: record the filing
-- (step-up gated). Full-catalog roles get both from the template materializer.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('adr.review', 'adr_case', 'review', 'billing', 'provider_entity_scope', ''),
  ('adr.submit', 'adr_case', 'submit', 'billing', 'provider_entity_scope', '')
ON CONFLICT ("key") DO NOTHING;
