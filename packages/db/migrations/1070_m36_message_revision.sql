-- M36 WP 1.3 / ADR-0055 — the append-only message revision chain.
-- Revision n holds the body that edit n REPLACED (revision 1 = the original). The head stays on `message`, so
-- `message.body_sha256` always verifies the head and the hot read path is unchanged. The app role may SELECT and
-- INSERT only: a revision is never rewritten or deleted by the application. Physical destruction rides the
-- retention/eraser path (wardenx_destruction), through the message FK cascade.

CREATE TABLE "message_revision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "revision_no" integer NOT NULL,
  "body_cipher" bytea NOT NULL,
  "body_sha256" text NOT NULL,
  "body_kind" message_body_kind NOT NULL,
  "references_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "body_written_at" timestamptz NOT NULL,
  "edited_by" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_revision_message_org_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_revision_no_positive" CHECK ("revision_no" >= 1),
  CONSTRAINT "message_revision_sha256_shape" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "message_revision_unique_no" UNIQUE ("organization_id", "message_id", "revision_no")
);--> statement-breakpoint

CREATE INDEX "message_revision_edited_by_idx" ON "message_revision" ("edited_by");--> statement-breakpoint

ALTER TABLE "message_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_revision_org_isolation" ON "message_revision"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_revision" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  -- The cipher is never copied into audit; the snapshot holds entity ids that may identify a patient.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['body_cipher','references_snapshot']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['body_cipher','references_snapshot']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_revision.' || lower(TG_OP), 'message_revision',
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
ALTER FUNCTION audit_phi_write_message_revision() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_revision"
  AFTER INSERT OR UPDATE OR DELETE ON message_revision
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_revision();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_revision" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_revision_destruction" ON "message_revision"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
