-- M6 Phase 1 admission evidence: requirement satisfaction may come from structured WardenX records
-- or an exact M22 document_version. Uploaded bytes stay in M22.
ALTER TABLE "admission"
  ADD COLUMN IF NOT EXISTS "hospice_physician_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_hospice_physician_idx"
  ON "admission" USING btree ("hospice_physician_id");--> statement-breakpoint
UPDATE "admission"
SET "hospice_physician_id" = "admitted_by_physician_id"
WHERE "hospice_physician_id" IS NULL
  AND "admitted_by_physician_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admission_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "admission_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "election_period_id" uuid,
  "requirement_type" text NOT NULL,
  "source_type" text DEFAULT 'structured' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "structured_entity_type" text,
  "structured_entity_id" uuid,
  "document_id" uuid,
  "document_version_id" uuid,
  "effective_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_membership_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admission_evidence_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admission_evidence_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admission_evidence_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admission_evidence_admission_id_admission_id_fk"
    FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admission_evidence_election_period_id_election_period_id_fk"
    FOREIGN KEY ("election_period_id") REFERENCES "public"."election_period"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admission_evidence_requirement_type_chk"
    CHECK (requirement_type IN ('notice_of_rights','election_statement','election_signature','cti','cti_signature')),
  CONSTRAINT "admission_evidence_source_type_chk"
    CHECK (source_type IN ('structured','uploaded')),
  CONSTRAINT "admission_evidence_status_chk"
    CHECK (status IN ('pending','valid','invalid','superseded')),
  CONSTRAINT "admission_evidence_structured_entity_type_chk"
    CHECK (structured_entity_type IS NULL OR structured_entity_type IN ('notice_of_rights','election_statement','cti')),
  CONSTRAINT "admission_evidence_source_integrity_chk"
    CHECK (
      (
        source_type = 'structured'
        AND structured_entity_type IS NOT NULL
        AND structured_entity_id IS NOT NULL
        AND document_id IS NULL
        AND document_version_id IS NULL
      ) OR (
        source_type = 'uploaded'
        AND structured_entity_type IS NULL
        AND structured_entity_id IS NULL
        AND document_id IS NOT NULL
        AND document_version_id IS NOT NULL
      )
    )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "admission_evidence_active_scope_uidx"
  ON "admission_evidence" USING btree ("organization_id","admission_id","election_period_id","requirement_type")
  WHERE status = 'valid' AND election_period_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admission_evidence_active_admission_scope_uidx"
  ON "admission_evidence" USING btree ("organization_id","admission_id","requirement_type")
  WHERE status = 'valid' AND election_period_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_evidence_admission_idx"
  ON "admission_evidence" USING btree ("organization_id","admission_id","requirement_type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_evidence_document_version_idx"
  ON "admission_evidence" USING btree ("organization_id","document_id","document_version_id");--> statement-breakpoint

ALTER TABLE "admission_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "admission_evidence_org" ON "admission_evidence";--> statement-breakpoint
CREATE POLICY "admission_evidence_org" ON "admission_evidence"
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "admission_evidence" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "admission_evidence" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_admission_evidence() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['metadata']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['metadata']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'admission_evidence.' || lower(TG_OP),
    'admission_evidence',
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
ALTER FUNCTION audit_phi_write_admission_evidence() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_admission_evidence" ON "admission_evidence";--> statement-breakpoint
CREATE TRIGGER "trg_audit_admission_evidence" AFTER INSERT OR UPDATE OR DELETE ON admission_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_admission_evidence();--> statement-breakpoint

INSERT INTO admission_evidence (
  organization_id, provider_entity_id, location_id, admission_id, patient_id, requirement_type,
  source_type, status, structured_entity_type, structured_entity_id, completed_at, metadata
)
SELECT n.organization_id, n.provider_entity_id, n.location_id, n.admission_id, n.patient_id,
  'notice_of_rights', 'structured', 'valid', 'notice_of_rights', n.id,
  n.acknowledged_at::timestamp with time zone, jsonb_build_object('backfilled', true)
FROM notice_of_rights_acknowledgment n
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO admission_evidence (
  organization_id, provider_entity_id, location_id, admission_id, patient_id, election_period_id,
  requirement_type, source_type, status, structured_entity_type, structured_entity_id, completed_at, metadata
)
SELECT es.organization_id, es.provider_entity_id, es.location_id, ep.admission_id, es.patient_id, es.election_period_id,
  'election_statement', 'structured', 'valid', 'election_statement', es.id,
  es.created_at, jsonb_build_object('backfilled', true)
FROM election_statement es
JOIN election_period ep ON ep.id = es.election_period_id
WHERE es.status <> 'voided'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO admission_evidence (
  organization_id, provider_entity_id, location_id, admission_id, patient_id, election_period_id,
  requirement_type, source_type, status, structured_entity_type, structured_entity_id, completed_at, metadata
)
SELECT es.organization_id, es.provider_entity_id, es.location_id, ep.admission_id, es.patient_id, es.election_period_id,
  'election_signature', 'structured', 'valid', 'election_statement', es.id,
  es.signed_at::timestamp with time zone, jsonb_build_object('backfilled', true)
FROM election_statement es
JOIN election_period ep ON ep.id = es.election_period_id
WHERE es.status = 'signed' AND es.signed_at IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO admission_evidence (
  organization_id, provider_entity_id, location_id, admission_id, patient_id, election_period_id,
  requirement_type, source_type, status, structured_entity_type, structured_entity_id, completed_at, metadata
)
SELECT c.organization_id, a.provider_entity_id, a.location_id, ep.admission_id, a.patient_id, c.election_period_id,
  'cti', 'structured', 'valid', 'cti', c.id,
  c.created_at, jsonb_build_object('backfilled', true)
FROM certification_of_terminal_illness c
JOIN election_period ep ON ep.id = c.election_period_id
JOIN admission a ON a.id = ep.admission_id
WHERE c.status <> 'voided'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO admission_evidence (
  organization_id, provider_entity_id, location_id, admission_id, patient_id, election_period_id,
  requirement_type, source_type, status, structured_entity_type, structured_entity_id, completed_at, metadata
)
SELECT c.organization_id, a.provider_entity_id, a.location_id, ep.admission_id, a.patient_id, c.election_period_id,
  'cti_signature', 'structured', 'valid', 'cti', c.id,
  c.hospice_md_signed_at, jsonb_build_object('backfilled', true, 'signedBy', 'hospice_physician')
FROM certification_of_terminal_illness c
JOIN election_period ep ON ep.id = c.election_period_id
JOIN admission a ON a.id = ep.admission_id
WHERE c.status <> 'voided' AND c.hospice_md_signed_at IS NOT NULL
ON CONFLICT DO NOTHING;
