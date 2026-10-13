-- M36 WP 2.10 - polls (P2, NON-CLINICAL ONLY).
--
-- message_poll: one poll per message; the QUESTION is the message body (written through the ordinary message write
--   path), so this row holds no free text. closed_at / closed_by_user_id are the only columns that change after
--   insert (wardenx_app gets a column-level UPDATE grant on exactly those two).
-- message_poll_option: 2..10 options (position 0..9, count enforced by the service). The label is envelope-encrypted
--   (label_cipher) under the tenant DEK like a message body, so a label typed in a DM never sits in plaintext.
-- message_poll_vote: ONE named vote per user per poll (unique key). Changing a vote is an UPDATE of option_id
--   (audited with before/after); a vote is never deleted by the app (wardenx_app has no DELETE), and a closed poll
--   is enforced in the service under a row lock on the poll.
--
-- The tenant boundary is the database's, not just the service's: every row carries organization_id, the poll
-- references the message through (organization_id, channel_id, message_id) -> message(...) (1083's unique key), options
-- reference the poll through (organization_id, poll_id) and votes reference the option through
-- (organization_id, poll_id, option_id), so a vote can only name an option of its own poll and org (an FK check
-- bypasses RLS; a composite FK cannot). FORCE-RLS on app.org_id with the NULLIF guard, like 1084.
--
-- Not patient data: the three-column PHI rule does not apply (no patient field). The service refuses to create a
-- poll in any channel with a patient link (care_team, bereavement).
--
-- Audit: poll and vote carry audit_phi_write_message_annotation() from 1084 (records the ACTOR, ids and timestamps
-- only). The option table carries its own function that scrubs label_cipher from the images, so an option's
-- ciphertext is never copied into audit_event (same rule as 1085's draft trigger).
--
-- Index coverage (test:fk-indexes:live): message edge led by message_poll_channel_message_idx (the FK's own column order); option -> poll led by
-- the (org, poll_id, id) key; vote -> option led by message_poll_vote_option_idx; poll-level vote reads are led by
-- the (org, poll_id, user_id) unique key. User edges point at the soft-deleted `user` parent (exempt).

CREATE TABLE "message_poll" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "closed_at" timestamptz,
  "closed_by_user_id" uuid REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_poll_message_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id", "message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_poll_message_unique" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "message_poll_org_id_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_poll_closed_shape" CHECK ((closed_at IS NULL) = (closed_by_user_id IS NULL))
);--> statement-breakpoint

CREATE INDEX "message_poll_channel_message_idx"
  ON "message_poll" ("organization_id", "channel_id", "message_id");--> statement-breakpoint

CREATE TABLE "message_poll_option" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "poll_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "label_cipher" bytea NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_poll_option_poll_fk"
    FOREIGN KEY ("organization_id", "poll_id")
    REFERENCES "message_poll"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_poll_option_poll_id_unique" UNIQUE ("organization_id", "poll_id", "id"),
  CONSTRAINT "message_poll_option_position_unique" UNIQUE ("organization_id", "poll_id", "position"),
  CONSTRAINT "message_poll_option_position_check" CHECK ("position" BETWEEN 0 AND 9)
);--> statement-breakpoint

CREATE TABLE "message_poll_vote" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "poll_id" uuid NOT NULL,
  "option_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_poll_vote_option_fk"
    FOREIGN KEY ("organization_id", "poll_id", "option_id")
    REFERENCES "message_poll_option"("organization_id", "poll_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_poll_vote_unique" UNIQUE ("organization_id", "poll_id", "user_id")
);--> statement-breakpoint
CREATE INDEX "message_poll_vote_option_idx"
  ON "message_poll_vote" ("organization_id", "poll_id", "option_id");--> statement-breakpoint

ALTER TABLE "message_poll" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_poll" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_poll_org_isolation" ON "message_poll"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_poll_destruction" ON "message_poll"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_poll" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("closed_at", "closed_by_user_id") ON "message_poll" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_poll" TO wardenx_destruction;--> statement-breakpoint

ALTER TABLE "message_poll_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_poll_option" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_poll_option_org_isolation" ON "message_poll_option"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_poll_option_destruction" ON "message_poll_option"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_poll_option" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_poll_option" TO wardenx_destruction;--> statement-breakpoint

ALTER TABLE "message_poll_vote" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_poll_vote" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_poll_vote_org_isolation" ON "message_poll_vote"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_poll_vote_destruction" ON "message_poll_vote"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_poll_vote" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("option_id", "updated_at") ON "message_poll_vote" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_poll_vote" TO wardenx_destruction;--> statement-breakpoint

CREATE TRIGGER "trg_audit_message_poll"
  AFTER INSERT OR UPDATE OR DELETE ON message_poll
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_annotation();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_poll_vote"
  AFTER INSERT OR UPDATE OR DELETE ON message_poll_vote
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_annotation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_poll_option() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['label_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['label_cipher']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_poll_option.' || lower(TG_OP), 'message_poll_option',
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
ALTER FUNCTION audit_phi_write_message_poll_option() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_poll_option"
  AFTER INSERT OR UPDATE OR DELETE ON message_poll_option
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_poll_option();--> statement-breakpoint

-- Defence in depth: the service locks the poll row (a vote takes FOR SHARE, a close the exclusive lock), but the
-- database also refuses a vote that is inserted or changed on a closed poll, whoever the caller is. SECURITY INVOKER:
-- it reads message_poll under the caller's own RLS context. FOR SHARE makes it serialise with a concurrent close.
CREATE OR REPLACE FUNCTION message_poll_vote_open_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM message_poll
    WHERE organization_id = NEW.organization_id AND id = NEW.poll_id AND closed_at IS NOT NULL
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'poll % is closed', NEW.poll_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_poll_vote_open"
  BEFORE INSERT OR UPDATE ON message_poll_vote
  FOR EACH ROW EXECUTE FUNCTION message_poll_vote_open_check();
