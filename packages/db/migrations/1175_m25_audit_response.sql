-- M25 milestone 7a-2 (hospice ADR/TPE/QIC PRD, milestone 7): the AUDIT RESPONSE packet and its filing proof. 7a-1 logged an
-- audit request (RAC / UPIC / SMRC / other) and its recorded deadlines; this migration lets a person assemble the
-- response, a DIFFERENT person sign it off, and record the filing with retained proof. NOTHING here states what an audit
-- contractor requires:
--   * the response checklist (`response_items`) is typed by the person from the request letter - no item is seeded;
--   * the filing channel is a label for how the response left the building;
--   * the due date stays a recorded deadline (1172). A response needs one, or an explicit "none stated in the request"
--     attestation (deadline_none_stated_*), the same pattern as appeal cited_evidence_none.
--
-- Three parts, all idempotent (the 1116/1117 renumber lesson):
--   1. audit_request gains the review/attestation/manifest columns and its guard learns the new rules
--      (a request can reach `responded` only with a frozen packet manifest; the filing record never changes after).
--   2. audit_request_document: the documents attached to the response, soft-removed, frozen once the packet is filed.
--   3. submission_attempt gains the `audit_response` purpose and an audit_request_id subject, so an audit response gets
--      the same proof-required, human-approved path as an ADR response (amending the 1124 CHECKs and one_live index).
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). The permission keys audit_request.review
-- and audit_request.submit are catalog rows here; existing tenants' roles get them from 1176.

ALTER TABLE "audit_request"
  ADD COLUMN IF NOT EXISTS "response_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "sent_to_review_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "reviewed_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deadline_none_stated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deadline_none_stated_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "response_channel" text,
  ADD COLUMN IF NOT EXISTS "response_confirmation_ref" text,
  ADD COLUMN IF NOT EXISTS "response_filed_late" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "packet_manifest" jsonb;--> statement-breakpoint

ALTER TABLE "audit_request" DROP CONSTRAINT IF EXISTS "audit_request_response_channel_check";--> statement-breakpoint
ALTER TABLE "audit_request" ADD CONSTRAINT "audit_request_response_channel_check"
  CHECK ("response_channel" IS NULL OR "response_channel" IN ('esmd','fax','mail','other'));--> statement-breakpoint
ALTER TABLE "audit_request" DROP CONSTRAINT IF EXISTS "audit_request_attestation_pair";--> statement-breakpoint
ALTER TABLE "audit_request" ADD CONSTRAINT "audit_request_attestation_pair"
  CHECK (("deadline_none_stated_at" IS NULL) = ("deadline_none_stated_by_membership_id" IS NULL));--> statement-breakpoint
-- A filed packet always carries who signed it off and the proof reference (a request cannot hold a manifest without them).
ALTER TABLE "audit_request" DROP CONSTRAINT IF EXISTS "audit_request_manifest_has_filing";--> statement-breakpoint
ALTER TABLE "audit_request" ADD CONSTRAINT "audit_request_manifest_has_filing"
  CHECK ("packet_manifest" IS NULL OR ("reviewed_by_membership_id" IS NOT NULL AND "response_channel" IS NOT NULL
    AND "response_confirmation_ref" IS NOT NULL AND btrim("response_confirmation_ref") <> '' AND "responded_at" IS NOT NULL));--> statement-breakpoint

-- Progress columns the 7a-1 grant did not cover. Anchor columns stay out of the grant.
GRANT UPDATE ("response_items", "sent_to_review_by_membership_id", "reviewed_by_membership_id", "reviewed_at",
  "deadline_none_stated_at", "deadline_none_stated_by_membership_id", "response_channel", "response_confirmation_ref",
  "response_filed_late", "packet_manifest") ON "audit_request" TO chartwarden_app;--> statement-breakpoint

-- The documents of the response. A detach stamps removed_at (the history of what was attached survives). claim_id is
-- the live claim of the request the document belongs to (the document is validated against THAT claim's patient).
CREATE TABLE IF NOT EXISTS "audit_request_document" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "audit_request_id" uuid NOT NULL REFERENCES "audit_request"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "attached_by_membership_id" uuid,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_request_document_live_unique" ON "audit_request_document" ("audit_request_id", "document_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_request_document_org_ix" ON "audit_request_document" ("organization_id", "attached_at");--> statement-breakpoint

ALTER TABLE "audit_request_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_request_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_request_document_org" ON "audit_request_document";--> statement-breakpoint
CREATE POLICY "audit_request_document_org" ON "audit_request_document" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_request_document" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("removed_at") ON "audit_request_document" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "audit_request_document" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_audit_request_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'audit_request_document.' || lower(TG_OP), 'audit_request_document', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_audit_request_document() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_audit_request_document" ON audit_request_document;--> statement-breakpoint
CREATE TRIGGER "trg_audit_audit_request_document" AFTER INSERT OR UPDATE OR DELETE ON audit_request_document FOR EACH ROW EXECUTE FUNCTION audit_phi_write_audit_request_document();--> statement-breakpoint

-- audit_request audit trigger: the checklist labels and the channel's own reference are free text, so they are scrubbed
-- along with the 1171 columns.
CREATE OR REPLACE FUNCTION audit_phi_write_audit_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['authority_name','request_reference','scope_note','response_items','response_confirmation_ref'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'audit_request.' || lower(TG_OP), 'audit_request', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_audit_request() OWNER TO chartwarden_audit_writer;--> statement-breakpoint

-- The state-machine guard (1171) plus the 7a-2 rules:
--   - in_review -> responded only with a frozen packet manifest (a response without its retained packet is not recorded);
--   - once the manifest is set, it, the sign-off and the filing facts never change (the retained record of what was sent);
--   - the "none stated" attestation, once made, never changes (a mistaken one is superseded by recording the deadline).
CREATE OR REPLACE FUNCTION m25_audit_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('withdrawn','closed') THEN
    RAISE EXCEPTION 'M25_AUDIT_FROZEN: audit_request % is % and cannot change', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'received' AND NEW.state IN ('in_assembly','withdrawn'))
    OR (OLD.state = 'in_assembly' AND NEW.state IN ('in_review','withdrawn'))
    OR (OLD.state = 'in_review' AND NEW.state IN ('responded','withdrawn'))
    OR (OLD.state = 'responded' AND NEW.state IN ('closed','withdrawn'))) THEN
    RAISE EXCEPTION 'M25_AUDIT_ILLEGAL_TRANSITION: audit_request % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  IF OLD.state = 'in_review' AND NEW.state = 'responded' AND NEW.packet_manifest IS NULL THEN
    RAISE EXCEPTION 'M25_AUDIT_RESPONSE_NEEDS_PACKET: audit_request % can be responded to only by filing a signed-off packet', OLD.id;
  END IF;
  IF OLD.packet_manifest IS NOT NULL AND (
       NEW.packet_manifest IS DISTINCT FROM OLD.packet_manifest
    OR NEW.response_channel IS DISTINCT FROM OLD.response_channel
    OR NEW.response_confirmation_ref IS DISTINCT FROM OLD.response_confirmation_ref
    OR NEW.response_filed_late IS DISTINCT FROM OLD.response_filed_late
    OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
    OR NEW.reviewed_by_membership_id IS DISTINCT FROM OLD.reviewed_by_membership_id
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.response_items IS DISTINCT FROM OLD.response_items) THEN
    RAISE EXCEPTION 'M25_AUDIT_FILING_IMMUTABLE: audit_request % has been filed; the filing record cannot change', OLD.id;
  END IF;
  IF OLD.deadline_none_stated_at IS NOT NULL AND (
       NEW.deadline_none_stated_at IS DISTINCT FROM OLD.deadline_none_stated_at
    OR NEW.deadline_none_stated_by_membership_id IS DISTINCT FROM OLD.deadline_none_stated_by_membership_id) THEN
    RAISE EXCEPTION 'M25_AUDIT_ATTESTATION_IMMUTABLE: audit_request % already carries the none-stated attestation', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- The documents of a filed packet are frozen (no attach, no detach), and cross-tenant parents fail closed (RLS hides
-- another tenant's audit_request from this SELECT).
CREATE OR REPLACE FUNCTION m25_audit_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_manifest jsonb;
BEGIN
  SELECT state, packet_manifest INTO v_state, v_manifest FROM audit_request
   WHERE id = NEW.audit_request_id AND organization_id = NEW.organization_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'M25_AUDIT_DOCUMENT_PARENT: audit_request % is not visible to this organization', NEW.audit_request_id;
  END IF;
  IF v_manifest IS NOT NULL THEN
    RAISE EXCEPTION 'M25_AUDIT_PACKET_FROZEN: the packet for audit_request % was filed; its documents cannot change', NEW.audit_request_id;
  END IF;
  IF v_state IN ('withdrawn','closed') THEN
    RAISE EXCEPTION 'M25_AUDIT_FROZEN: audit_request % is % and its documents cannot change', NEW.audit_request_id, v_state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_document_guard" ON audit_request_document;--> statement-breakpoint
CREATE TRIGGER "trg_audit_document_guard" BEFORE INSERT OR UPDATE ON audit_request_document FOR EACH ROW EXECUTE FUNCTION m25_audit_document_guard();--> statement-breakpoint

-- submission_attempt: the audit_response purpose and its subject. Exactly one subject of four.
ALTER TABLE "submission_attempt" ADD COLUMN IF NOT EXISTS "audit_request_id" uuid REFERENCES "audit_request"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "submission_attempt" DROP CONSTRAINT IF EXISTS "submission_attempt_purpose_check";--> statement-breakpoint
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_purpose_check"
  CHECK ("purpose" IN ('adr_response','appeal_request','reopening_request','qic_escalation_request','audit_response'));--> statement-breakpoint
ALTER TABLE "submission_attempt" DROP CONSTRAINT IF EXISTS "submission_attempt_one_subject";--> statement-breakpoint
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_one_subject"
  CHECK (num_nonnulls("adr_case_id","appeal_case_id","reopening_case_id","audit_request_id") = 1);--> statement-breakpoint
ALTER TABLE "submission_attempt" DROP CONSTRAINT IF EXISTS "submission_attempt_purpose_subject";--> statement-breakpoint
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_purpose_subject" CHECK (
    ("purpose" = 'adr_response' AND "adr_case_id" IS NOT NULL)
    OR ("purpose" IN ('appeal_request','qic_escalation_request') AND "appeal_case_id" IS NOT NULL)
    OR ("purpose" = 'reopening_request' AND "reopening_case_id" IS NOT NULL)
    OR ("purpose" = 'audit_response' AND "audit_request_id" IS NOT NULL));--> statement-breakpoint
-- One live attempt per (subject, purpose): the unique index learns the fourth subject.
DROP INDEX IF EXISTS "submission_attempt_one_live";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "submission_attempt_one_live" ON "submission_attempt"
  ("organization_id", "purpose", (coalesce("adr_case_id", "appeal_case_id", "reopening_case_id", "audit_request_id")))
  WHERE "status" IN ('prepared','queued','sending','sent','needs_manual');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_submission_attempt_audit" ON "submission_attempt" ("audit_request_id") WHERE "audit_request_id" IS NOT NULL;--> statement-breakpoint

-- audit_request.review: sign off a response packet (a person other than whoever sent it to review).
-- audit_request.submit: record the filing (step-up gated). Full-catalog roles receive them from the template
-- materializer; existing tenants' roles get them from 1176.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('audit_request.review', 'audit_request', 'review', 'billing', 'provider_entity_scope', ''),
  ('audit_request.submit', 'audit_request', 'submit', 'billing', 'provider_entity_scope', '')
ON CONFLICT ("key") DO NOTHING;
