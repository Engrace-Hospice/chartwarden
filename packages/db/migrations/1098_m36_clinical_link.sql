-- M36 WP 3.2 - clinical links. A message points at ONE record owned by another module; this table holds only the
-- pointer: (kind, source id) and the patient the source belongs to (null only for an IDG meeting). No title, label,
-- status or snapshot of the record is stored: the owning module's `linkSummary` seam supplies those at open time,
-- after re-checking the viewer's permission and scope. No UPDATE grant: a link is created or removed, never edited.

CREATE TABLE "clinical_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "link_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "patient_id" uuid,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "clinical_link_message_org_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "clinical_link_kind_shape"
    CHECK ("link_kind" IN ('medication', 'order', 'care_plan', 'assessment', 'visit', 'document', 'idg_meeting')),
  CONSTRAINT "clinical_link_unique_target"
    UNIQUE ("organization_id", "message_id", "link_kind", "source_id")
);--> statement-breakpoint

CREATE INDEX "clinical_link_source_idx"
  ON "clinical_link" ("organization_id", "link_kind", "source_id");--> statement-breakpoint

ALTER TABLE "clinical_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinical_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clinical_link_org_isolation" ON "clinical_link"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "clinical_link" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_clinical_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  -- source_id and patient_id identify a clinical record and a patient; record that the link changed without copying them.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['source_id','patient_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['source_id','patient_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'clinical_link.' || lower(TG_OP), 'clinical_link',
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
ALTER FUNCTION audit_phi_write_clinical_link() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clinical_link"
  AFTER INSERT OR UPDATE OR DELETE ON clinical_link
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clinical_link();--> statement-breakpoint

GRANT SELECT, DELETE ON "clinical_link" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "clinical_link_destruction" ON "clinical_link"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
