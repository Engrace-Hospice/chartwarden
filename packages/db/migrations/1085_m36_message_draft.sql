-- M36 WP 2.5 - server-side message drafts: one PRIVATE, encrypted draft per (user, channel, thread root).
--   parent_message_id NULL     = the channel composer's draft
--   parent_message_id = <root> = that thread's reply draft
-- The body (and the mention references that ride with it) is one JSON document sealed under the tenant DEK exactly like
-- message.body_cipher; only `revision`, `device_id` and timestamps are plaintext (no PHI). `revision` + `device_id` drive
-- the cross-device conflict rule (packages/messaging/src/drafts).
--
-- Isolation is two-layered: the standard org policy AND the owner (a draft belongs to its user, not to the tenant), so
-- even a bug in a query that forgets `user_id = ...` cannot return a colleague's draft. Physical deletion on a channel or
-- tenant erase rides the composite channel FK (ON DELETE CASCADE), the eraser's explicit delete, and wardenx_destruction.
--
-- Audit: INSERT and DELETE only. Autosave rewrites the row on every debounce tick; auditing each UPDATE would write one
-- audit_event per keystroke burst for text that is not yet a record of care. The create and the discard/send delete are
-- audited; the cipher is scrubbed from both images.

CREATE TABLE "message_draft" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "parent_message_id" uuid,
  "body_cipher" bytea NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "device_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_draft_channel_org_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE,
  -- A thread draft can only point at a root in its own channel (the unique added by 1083).
  CONSTRAINT "message_draft_parent_org_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id", "parent_message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_draft_revision_positive" CHECK ("revision" >= 1),
  CONSTRAINT "message_draft_device_shape" CHECK (char_length("device_id") BETWEEN 1 AND 64),
  -- NULLS NOT DISTINCT: the channel draft (parent NULL) is also unique per user + channel.
  CONSTRAINT "message_draft_owner_slot_unique"
    UNIQUE NULLS NOT DISTINCT ("organization_id", "user_id", "channel_id", "parent_message_id")
);--> statement-breakpoint

-- FK-index coverage (test:fk-indexes:live): (org, channel[, parent]) for the channel and parent FKs; user_id for the user FK.
CREATE INDEX "message_draft_org_channel_parent_idx" ON "message_draft" ("organization_id", "channel_id", "parent_message_id");--> statement-breakpoint
CREATE INDEX "message_draft_user_idx" ON "message_draft" ("user_id");--> statement-breakpoint

ALTER TABLE "message_draft" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_draft" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_draft_owner_isolation" ON "message_draft"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- A rewrite may change the sealed body, revision, device and timestamp only; identity columns are not updatable.
GRANT SELECT, INSERT, DELETE ON "message_draft" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("body_cipher", "revision", "device_id", "updated_at") ON "message_draft" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  -- The cipher is never copied into audit.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['body_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['body_cipher']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_draft.' || lower(TG_OP), 'message_draft',
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
ALTER FUNCTION audit_phi_write_message_draft() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_draft"
  AFTER INSERT OR DELETE ON message_draft
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_draft();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_draft" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_draft_destruction" ON "message_draft"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
