-- M36 WP 6.8 (ADR-0097, PROPOSED) - acknowledge-required broadcast. The tenant flag messaging.ack_broadcast (absent = off) gates every route;
-- nothing here is reachable while it is off. No new permission: marking and overseeing reuse messaging.announce, acknowledging is the
-- recipient's own act (messaging.read) and is limited by the audience row, not by a key.
--   * message_ack_broadcast: one row per announcement that REQUIRES acknowledgment (unique per message). Written once, by the announcement's
--     own author, against a live announcement-channel message. Never updated, never deleted (the app role has no UPDATE/DELETE grant; the guard
--     also refuses an UPDATE).
--   * message_ack_broadcast_recipient: the audience frozen at publish, one row per person. The ONLY change a row ever takes is
--     acknowledged_at going from NULL to the database clock, by that person themself. The author is never in the audience; the sender cannot
--     write a recipient's acknowledgment. Opening an announcement (message_receipt, WP 2.9) is a separate fact and never touches this table.
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS. Audit rows carry ids and instants only (no names, no text).
CREATE TABLE "message_ack_broadcast" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_ack_broadcast_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_ack_broadcast_message_unique" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "message_ack_broadcast_message_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_ack_broadcast_created_by_idx" ON "message_ack_broadcast" ("created_by", "created_at");--> statement-breakpoint
CREATE INDEX "message_ack_broadcast_created_idx" ON "message_ack_broadcast" ("organization_id", "created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_ack_broadcast_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'message_ack_broadcast_immutable: a broadcast is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_ack_broadcast_actor: a broadcast is recorded only by its creator' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the author of a live message in the announcement channel may require acknowledgment of it; channel_id is derived, not trusted.
  SELECT m.channel_id INTO NEW.channel_id
    FROM message m JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
   WHERE m.organization_id = NEW.organization_id AND m.id = NEW.message_id
     AND m.deleted_at IS NULL AND m.author_user_id = v_actor AND c.channel_kind = 'announcement';
  IF NEW.channel_id IS NULL THEN
    RAISE EXCEPTION 'message_ack_broadcast_message: only the author of a live announcement may require acknowledgment' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_broadcast_guard"
  BEFORE INSERT OR UPDATE ON "message_ack_broadcast"
  FOR EACH ROW EXECUTE FUNCTION message_ack_broadcast_guard();--> statement-breakpoint

CREATE TABLE "message_ack_broadcast_recipient" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "broadcast_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id"),
  "acknowledged_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_ack_broadcast_recipient_unique" UNIQUE ("broadcast_id", "user_id"),
  CONSTRAINT "message_ack_broadcast_recipient_broadcast_fk"
    FOREIGN KEY ("organization_id", "broadcast_id")
    REFERENCES "message_ack_broadcast"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_ack_broadcast_recipient_user_idx" ON "message_ack_broadcast_recipient" ("organization_id", "user_id") WHERE "acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_ack_broadcast_recipient_user_fk_idx" ON "message_ack_broadcast_recipient" ("user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_ack_broadcast_recipient_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The audience is written by the broadcast's creator, never includes them, and starts unacknowledged.
    IF NOT EXISTS (
      SELECT 1 FROM message_ack_broadcast b
       WHERE b.organization_id = NEW.organization_id AND b.id = NEW.broadcast_id
         AND b.created_by = v_actor AND b.created_by <> NEW.user_id) THEN
      RAISE EXCEPTION 'message_ack_broadcast_recipient_audience: the audience is set by the creator and never includes them' USING ERRCODE = 'check_violation';
    END IF;
    NEW.acknowledged_at := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: one move only, NULL -> the database clock, by that person themself.
  IF (to_jsonb(NEW) - 'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_at') THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_immutable: only the acknowledgment instant is set' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_once: an acknowledgment is recorded once and never withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_self: only the person themself acknowledges' USING ERRCODE = 'check_violation';
  END IF;
  NEW.acknowledged_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_broadcast_recipient_guard"
  BEFORE INSERT OR UPDATE ON "message_ack_broadcast_recipient"
  FOR EACH ROW EXECUTE FUNCTION message_ack_broadcast_recipient_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads and inserts; only the acknowledgment instant updates; nothing deletes.
ALTER TABLE "message_ack_broadcast" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_ack_broadcast" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_ack_broadcast_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_ack_broadcast_recipient" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_ack_broadcast_org_isolation" ON "message_ack_broadcast"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_ack_broadcast_recipient_org_isolation" ON "message_ack_broadcast_recipient"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_ack_broadcast" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_ack_broadcast_recipient" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("acknowledged_at") ON "message_ack_broadcast_recipient" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern. Rows hold ids and instants only.
CREATE OR REPLACE FUNCTION audit_phi_write_message_ack_broadcast() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_message_ack_broadcast() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_ack_broadcast"
  AFTER INSERT OR UPDATE OR DELETE ON message_ack_broadcast
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_ack_broadcast('message_ack_broadcast');--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_ack_broadcast_recipient"
  AFTER INSERT OR UPDATE OR DELETE ON message_ack_broadcast_recipient
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_ack_broadcast('message_ack_broadcast_recipient');
