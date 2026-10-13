-- M36 WP 2.6 - scheduled send: a PRIVATE, sealed message-to-be, sent by the dispatcher (`messaging.scheduled_send`) at
-- `scheduled_for` after it re-checks, at dispatch, that the sender may still send it.
--   parent_message_id NULL     = a channel message
--   parent_message_id = <root> = a reply in that thread
-- The body is sealed under the tenant DEK exactly like message.body_cipher and message_draft.body_cipher; the other columns
-- are plaintext and carry no PHI (ids, an instant, an IANA zone name, a status and a reason code).
--
-- Lifecycle: a row exists while the message is `pending` or `blocked`. A successful send DELETEs the row in the SAME
-- transaction that inserts the message (client_message_id = this row's id, so a retried tick cannot send twice); a cancel
-- DELETEs it. A re-check that fails flips it to `blocked` with a reason code and the sender is notified; the sender can
-- reschedule (back to `pending`) or cancel it. Nothing is ever sent from a `blocked` row.
--
-- Isolation: org policy AND owner. A request always runs with `app.user_id` set, so it sees only its own user's rows. The
-- dispatcher's per-org sweep runs with NO user bound to LIST due rows (it reads ids and times, never the cipher) and then
-- processes each row under its owner's context. A bug that forgets `user_id = ...` in a request therefore still cannot
-- return a colleague's row. Deletion on a channel or tenant erase rides the composite channel FK (ON DELETE CASCADE),
-- the eraser's explicit delete, and wardenx_destruction.
--
-- Audit: INSERT, UPDATE and DELETE (low volume: a human schedules, reschedules, cancels or has one sent). The cipher is
-- scrubbed from both images.

CREATE TABLE "scheduled_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "parent_message_id" uuid,
  "body_cipher" bytea NOT NULL,
  "scheduled_for" timestamptz NOT NULL,
  "time_zone" text NOT NULL DEFAULT 'UTC',
  "status" text NOT NULL DEFAULT 'pending',
  "blocked_reason" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "scheduled_message_channel_org_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE,
  -- A scheduled reply can only point at a root in its own channel (the unique added by 1083).
  CONSTRAINT "scheduled_message_parent_org_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id", "parent_message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_message_status_valid" CHECK ("status" IN ('pending', 'blocked')),
  CONSTRAINT "scheduled_message_blocked_reason_valid" CHECK (
    "blocked_reason" IS NULL OR "blocked_reason" IN
      ('channel_archived', 'not_member', 'permission_revoked', 'announcement_not_permitted',
       'parent_unavailable', 'dispatch_failed')),
  CONSTRAINT "scheduled_message_blocked_has_reason" CHECK (("status" = 'blocked') = ("blocked_reason" IS NOT NULL)),
  CONSTRAINT "scheduled_message_attempts_nonneg" CHECK ("attempts" >= 0),
  CONSTRAINT "scheduled_message_time_zone_shape" CHECK (char_length("time_zone") BETWEEN 1 AND 64)
);--> statement-breakpoint

-- The sweep's lookup: due, pending rows of one org. FK-index coverage (test:fk-indexes:live): (org, channel, parent)
-- for the channel and parent FKs; user_id for the user FK.
CREATE INDEX "scheduled_message_due_idx" ON "scheduled_message" ("organization_id", "scheduled_for") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "scheduled_message_org_channel_parent_idx" ON "scheduled_message" ("organization_id", "channel_id", "parent_message_id");--> statement-breakpoint
CREATE INDEX "scheduled_message_user_idx" ON "scheduled_message" ("user_id");--> statement-breakpoint

ALTER TABLE "scheduled_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduled_message_owner_isolation" ON "scheduled_message"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
         AND (NULLIF(current_setting('app.user_id', true), '') IS NULL
              OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Identity, owner and the sealed body are not updatable; only the schedule, the state and the retry counter move.
GRANT SELECT, INSERT, DELETE ON "scheduled_message" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("scheduled_for", "time_zone", "status", "blocked_reason", "attempts", "updated_at") ON "scheduled_message" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_scheduled_message() RETURNS trigger
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
    'user', 'scheduled_message.' || lower(TG_OP), 'scheduled_message',
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
ALTER FUNCTION audit_phi_write_scheduled_message() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_scheduled_message"
  AFTER INSERT OR UPDATE OR DELETE ON scheduled_message
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_scheduled_message();--> statement-breakpoint

GRANT SELECT, DELETE ON "scheduled_message" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "scheduled_message_destruction" ON "scheduled_message"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
