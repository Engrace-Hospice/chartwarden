-- M36 PR4 — authoritative structured staff mentions and patient references.
-- Offsets are UTF-16 code units. No display label or message body is duplicated here.

ALTER TABLE "message" ADD CONSTRAINT "message_org_id_id_unique"
  UNIQUE ("organization_id", "id");--> statement-breakpoint

CREATE TABLE "message_entity_reference" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "reference_kind" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_entity_reference_message_org_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_entity_reference_kind_shape"
    CHECK ("reference_kind" IN ('staff', 'patient')),
  CONSTRAINT "message_entity_reference_range_shape"
    CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset"),
  CONSTRAINT "message_entity_reference_unique_range"
    UNIQUE ("organization_id", "message_id", "reference_kind", "entity_id", "start_offset", "end_offset")
);--> statement-breakpoint

CREATE INDEX "message_entity_reference_message_idx"
  ON "message_entity_reference" ("organization_id", "message_id");--> statement-breakpoint
CREATE INDEX "message_entity_reference_entity_idx"
  ON "message_entity_reference" ("organization_id", "reference_kind", "entity_id", "created_at");--> statement-breakpoint

ALTER TABLE "message_entity_reference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_entity_reference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_entity_reference_org_isolation" ON "message_entity_reference"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "message_entity_reference" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_entity_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  -- entity_id may identify a patient; record that it changed without copying the identifier.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['entity_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['entity_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_entity_reference.' || lower(TG_OP), 'message_entity_reference',
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
ALTER FUNCTION audit_phi_write_message_entity_reference() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_entity_reference"
  AFTER INSERT OR UPDATE OR DELETE ON message_entity_reference
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_entity_reference();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_entity_reference" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_entity_reference_destruction" ON "message_entity_reference"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
