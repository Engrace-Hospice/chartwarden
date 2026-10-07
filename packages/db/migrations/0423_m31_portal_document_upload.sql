-- GAP-092 — M31 portal document upload: ENCRYPTED STAGING (spec §3.3 `portal_document_upload`).
--
-- `upload-init` answered a placeholder `https://uploads.invalid/...` URL and `upload-complete` answered "received"
-- while nothing was staged or handed to M22. Now: init records an upload intent (validated size / MIME / allowlist,
-- discharged-read-only refused); the bytes PUT to the M31 content route are checked against the declared MIME's
-- magic bytes and stored here ONLY as a tenant-DEK envelope (`content_cipher`, §3.6 audit-denylisted); complete
-- hands the decrypted bytes to M22's intake (a verified document + an intake batch) and clears the staged
-- ciphertext, leaving only the provenance row (document / batch ids, digest). A failed hand-off keeps the staged
-- bytes so the caregiver can retry `complete` without re-uploading.
--
-- PATIENT-BEARING (patient_id), so beyond organization_id NOT NULL it carries the ARCH-011 provider_entity_id NOT NULL +
-- location_id (nullable), copied from the account's active grant for the patient. FORCEd RLS on app.org_id; no DELETE
-- for the app role (the portal eraser deletes under wardenx_destruction). Idempotent.
CREATE TABLE IF NOT EXISTS "portal_document_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"portal_account_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"declared_mime" text NOT NULL,
	"expected_byte_size" integer NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"content_cipher" text,
	"content_key_version" integer,
	"byte_size" integer,
	"content_sha256" text,
	"rejection_code" text,
	"document_id" uuid,
	"intake_batch_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"staged_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_document_upload_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "portal_document_upload_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "portal_document_upload_account_fk"
		FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_account"("id") ON DELETE restrict,
	CONSTRAINT "portal_document_upload_status_chk" CHECK ("status" IN ('initiated', 'staged', 'submitted', 'rejected', 'expired')),
	CONSTRAINT "portal_document_upload_size_chk" CHECK ("expected_byte_size" > 0),
	-- Staged bytes exist exactly while the upload is `staged`; submission clears them (M22 owns the document).
	CONSTRAINT "portal_document_upload_staged_cipher_chk" CHECK (
		("status" = 'staged') = ("content_cipher" IS NOT NULL)
	),
	CONSTRAINT "portal_document_upload_submitted_chk" CHECK (
		"status" <> 'submitted' OR ("document_id" IS NOT NULL AND "intake_batch_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_document_upload_account_idx" ON "portal_document_upload" ("portal_account_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_document_upload_org_status_idx" ON "portal_document_upload" ("organization_id", "status", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_document_upload_patient_idx" ON "portal_document_upload" ("patient_id");--> statement-breakpoint

ALTER TABLE "portal_document_upload" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_document_upload" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "portal_document_upload_org" ON "portal_document_upload"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "portal_document_upload" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "portal_document_upload" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "portal_document_upload" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_portal_document_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['content_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'portal_document_upload.' || lower(TG_OP), 'portal_document_upload', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('patient_id', COALESCE(NEW.patient_id, OLD.patient_id), 'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id), 'location_id', COALESCE(NEW.location_id, OLD.location_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_portal_document_upload() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_portal_document_upload" ON portal_document_upload;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_document_upload" AFTER INSERT OR UPDATE OR DELETE ON portal_document_upload
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_document_upload();
