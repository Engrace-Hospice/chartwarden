-- Durable two-step document uploads. Metadata is committed only after object-store verification.
CREATE TABLE IF NOT EXISTS "document_upload" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE restrict,
  "created_by_membership_id" uuid NOT NULL,
  "target_document_id" uuid,
  "patient_id" uuid,
  "admission_id" uuid,
  "retention_class" "document_retention_class" NOT NULL,
  "aggregate_type" "document_aggregate_type" NOT NULL,
  "aggregate_id" uuid,
  "title" text NOT NULL,
  "patient_facing" boolean DEFAULT false NOT NULL,
  "object_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "expected_byte_size" text NOT NULL,
  "expected_sha256_hex" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "completed_document_id" uuid,
  "completed_version_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "document_upload_status_shape"
    CHECK (status IN ('pending', 'completed', 'aborted', 'expired')),
  CONSTRAINT "document_upload_byte_size_shape"
    CHECK (expected_byte_size ~ '^[1-9][0-9]*$'),
  CONSTRAINT "document_upload_sha256_shape"
    CHECK (expected_sha256_hex ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_upload_completion_shape" CHECK (
    (status = 'completed') =
    (completed_document_id IS NOT NULL AND completed_version_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_upload_object_key_uk"
  ON "document_upload" ("object_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_upload_pending_expiry_idx"
  ON "document_upload" ("organization_id", "status", "expires_at");--> statement-breakpoint
ALTER TABLE "document_upload" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_upload" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_upload_org" ON "document_upload"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "document_upload" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "document_upload" TO wardenx_admin;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_document_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_org uuid;
  v_rid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY['title','object_key','expected_sha256_hex']); v_after := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := audit_scrub(to_jsonb(OLD), ARRAY['title','object_key','expected_sha256_hex']);
    v_after := audit_scrub(to_jsonb(NEW), ARRAY['title','object_key','expected_sha256_hex']);
  ELSE
    v_before := NULL;
    v_after := audit_scrub(to_jsonb(NEW), ARRAY['title','object_key','expected_sha256_hex']);
  END IF;
  v_org := NULLIF(COALESCE(v_after->>'organization_id', v_before->>'organization_id'), '')::uuid;
  v_rid := NULLIF(COALESCE(v_after->>'id', v_before->>'id'), '')::uuid;
  INSERT INTO audit_event (
    organization_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, retention_class
  ) VALUES (
    v_org, 'system', TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, v_rid,
    'db-trigger', 'success', 'info', v_before, v_after, 'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "document_upload_audit"
  AFTER INSERT OR UPDATE OR DELETE ON document_upload
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_document_upload();
