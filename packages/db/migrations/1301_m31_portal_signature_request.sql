-- compat: expand
-- M31 ADR-0107 (PROPOSED) - portal signature request: a staff-sent request that a patient or their representative sign an
-- admission document (Election Statement, Notice of Patient Rights, HIPAA NPP acknowledgement, Consent to Treat) in the portal.
--   * The row is the portal-facing WORKFLOW record only. M06 (election, NOR) and M39 (consent) stay the authoritative signing
--     state machines; `target_ref` points at the M06 / M39 row the sign path produced (logical FK, no cross-module DB FK).
--   * Lifecycle: pending -> signed | uploaded_pending_review | voided; uploaded_pending_review -> signed | pending | voided.
--     `signed` and `voided` are terminal. A voided request is never reopened (staff send a new one). No DELETE for the app role.
--   * A portal upload of a signed paper copy never marks the document signed by itself: it parks the request in
--     `uploaded_pending_review` (pointing at the existing portal_document_upload row) until staff accept it.
--   * Signer evidence (typed name, relationship, reason the patient did not sign) is PHI and audit-denylisted. The audit trail
--     carries ids, status and instants only. `attestation_sha256` pins the exact attestation text the signer agreed to.
--   * Reminders repeat until the request is signed or voided (no expiry); `last_reminded_at` / `reminder_count` drive the sweep.
-- Patient-bearing: carries organization_id NOT NULL + provider_entity_id NOT NULL + location_id (nullable) (three-column rule).
CREATE TABLE "portal_signature_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "doc_kind" text NOT NULL,
  "template_key" text NOT NULL,
  "template_version" text NOT NULL,
  "target_ref" uuid,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "user"("id"),
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "last_reminded_at" timestamptz,
  "reminder_count" integer DEFAULT 0 NOT NULL,
  "voided_by" uuid REFERENCES "user"("id"),
  "voided_at" timestamptz,
  "void_reason" text,
  "signed_by_portal_account_id" uuid REFERENCES "portal_account"("id") ON DELETE RESTRICT,
  "signer_grant_kind" text,
  "signer_role" text,
  "signed_typed_name" text,
  "signer_relationship_text" text,
  "patient_unable_reason" text,
  "attestation_sha256" text,
  "portal_session_id" uuid,
  "idempotency_key" text,
  "signed_at" timestamptz,
  "uploaded_document_upload_id" uuid REFERENCES "portal_document_upload"("id") ON DELETE RESTRICT,
  "reviewed_by" uuid REFERENCES "user"("id"),
  "reviewed_at" timestamptz,
  "review_outcome" text,
  CONSTRAINT "portal_signature_request_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "portal_signature_request_doc_kind_chk" CHECK ("doc_kind" IN
    ('election_statement', 'notice_of_patient_rights', 'hipaa_npp_acknowledgement', 'consent_to_treat')),
  CONSTRAINT "portal_signature_request_status_chk" CHECK ("status" IN
    ('pending', 'signed', 'uploaded_pending_review', 'voided')),
  CONSTRAINT "portal_signature_request_signer_role_chk" CHECK ("signer_role" IS NULL OR "signer_role" IN
    ('patient', 'legal_representative', 'caregiver_on_behalf')),
  CONSTRAINT "portal_signature_request_review_outcome_chk" CHECK ("review_outcome" IS NULL OR "review_outcome" IN
    ('accepted', 'rejected')),
  CONSTRAINT "portal_signature_request_reminder_chk" CHECK ("reminder_count" >= 0),
  -- A signed request carries the full signer evidence; a request that is not signed carries none of the signing instant.
  CONSTRAINT "portal_signature_request_signed_chk" CHECK (
    ("status" = 'signed') = (
      "signed_by_portal_account_id" IS NOT NULL AND "signer_grant_kind" IS NOT NULL AND "signer_role" IS NOT NULL
      AND "signed_typed_name" IS NOT NULL AND "attestation_sha256" IS NOT NULL AND "portal_session_id" IS NOT NULL
      AND "idempotency_key" IS NOT NULL AND "signed_at" IS NOT NULL
    )
  ),
  -- Someone other than the patient signing (representative or caregiver) says who they are and, for a caregiver, why the patient did not.
  CONSTRAINT "portal_signature_request_on_behalf_chk" CHECK (
    "status" <> 'signed' OR "signer_role" = 'patient'
    OR ("signer_relationship_text" IS NOT NULL AND ("signer_role" <> 'caregiver_on_behalf' OR "patient_unable_reason" IS NOT NULL))
  ),
  CONSTRAINT "portal_signature_request_voided_chk" CHECK (
    ("status" = 'voided') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
  ),
  CONSTRAINT "portal_signature_request_upload_chk" CHECK (
    "status" <> 'uploaded_pending_review' OR "uploaded_document_upload_id" IS NOT NULL
  )
);--> statement-breakpoint
-- One open request per (patient, document kind): a second send while one is open would double-notify and race the signature.
CREATE UNIQUE INDEX "portal_signature_request_open_unique"
  ON "portal_signature_request" ("organization_id", "patient_id", "doc_kind")
  WHERE "status" IN ('pending', 'uploaded_pending_review');--> statement-breakpoint
-- A retried sign (same idempotency key) lands on the same row, never a second signature.
CREATE UNIQUE INDEX "portal_signature_request_idem_unique"
  ON "portal_signature_request" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_signature_request_patient_idx" ON "portal_signature_request" ("organization_id", "patient_id", "status");--> statement-breakpoint
CREATE INDEX "portal_signature_request_reminder_idx"
  ON "portal_signature_request" ("organization_id", "last_reminded_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "portal_signature_request_requested_by_idx" ON "portal_signature_request" ("requested_by");--> statement-breakpoint
CREATE INDEX "portal_signature_request_voided_by_idx" ON "portal_signature_request" ("voided_by") WHERE "voided_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_signature_request_reviewed_by_idx" ON "portal_signature_request" ("reviewed_by") WHERE "reviewed_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_signature_request_account_idx"
  ON "portal_signature_request" ("signed_by_portal_account_id") WHERE "signed_by_portal_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_signature_request_upload_idx"
  ON "portal_signature_request" ("uploaded_document_upload_id") WHERE "uploaded_document_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portal_signature_request_provider_entity_idx" ON "portal_signature_request" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "portal_signature_request_location_idx" ON "portal_signature_request" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

-- Transition guard (SECURITY INVOKER; no actor binding, so it never reads app.user_id). It fixes what may change and when:
-- request identity never changes; signed and voided are terminal; no DELETE; signed_at / voided_at are the database clock.
CREATE OR REPLACE FUNCTION portal_signature_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal_signature_request_immutable: a signature request is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'portal_signature_request_insert: a request starts pending' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    NEW.reminder_count := 0;
    RETURN NEW;
  END IF;
  -- UPDATE: identity columns never move.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.doc_kind IS DISTINCT FROM OLD.doc_kind OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id THEN
    RAISE EXCEPTION 'portal_signature_request_identity: what was requested of whom never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('signed', 'voided') THEN
    RAISE EXCEPTION 'portal_signature_request_terminal: a % request is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('signed', 'uploaded_pending_review', 'voided'))
    OR (OLD.status = 'uploaded_pending_review' AND NEW.status IN ('signed', 'pending', 'voided'))) THEN
    RAISE EXCEPTION 'portal_signature_request_transition: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'signed' THEN NEW.signed_at := now(); END IF;
  IF NEW.status = 'voided' THEN NEW.voided_at := now(); END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_portal_signature_request_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "portal_signature_request"
  FOR EACH ROW EXECUTE FUNCTION portal_signature_request_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads, inserts and updates; nothing deletes.
ALTER TABLE "portal_signature_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_signature_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "portal_signature_request_org_isolation" ON "portal_signature_request"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "portal_signature_request" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern; the signer's typed name, relationship and reasons are scrubbed from the audit before/after images.
CREATE OR REPLACE FUNCTION audit_phi_write_portal_signature_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['signed_typed_name', 'signer_relationship_text', 'patient_unable_reason', 'void_reason']::text[];
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
ALTER FUNCTION audit_phi_write_portal_signature_request() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_signature_request"
  AFTER INSERT OR UPDATE OR DELETE ON portal_signature_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_signature_request('portal_signature_request');
