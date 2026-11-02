-- compat: expand
-- M36 ADR-0106 (PROPOSED) - emergency message with a per-recipient acknowledgment. The tenant flag messaging.emergency (absent = off) gates every
-- route (service layer); nothing here is reachable while it is off. No new permission: sending reuses messaging.send, acknowledging is the
-- recipient's own act (messaging.read) and is limited by the frozen audience row, not by a key.
--   * message_emergency: one row per message the author declared an EMERGENCY (unique per message). Written once, by the message's own author,
--     against a live message, in any channel. Never updated, never deleted (no UPDATE/DELETE grant; the guard also refuses both). The
--     acknowledgment deadline is fixed at 15 minutes after creation on the database clock (ACK_DEADLINE_POLICY.urgent default); a client cannot
--     choose it. Re-alarm and escalation (ADR-0106 B) add their own columns in a later expand migration.
--   * message_emergency_recipient: the audience, frozen at send. A row may only be inserted in the SAME transaction that created the emergency
--     (created_at = now()), so no one is added after the fact. The author is never in the audience. The ONLY change a row ever takes is
--     acknowledged_at going from NULL to the database clock, by that person themself; a late acknowledgment (after the deadline) is still recorded.
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS. Audit rows carry ids and instants only (no names, no text).
-- Modelled on 1200 (acknowledge-required broadcast), which is announcement-channel only and display-only; this is its any-channel, deadline-bound sibling.
CREATE TABLE "message_emergency" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "deadline_at" timestamptz DEFAULT (now() + interval '15 minutes') NOT NULL,
  CONSTRAINT "message_emergency_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_emergency_message_unique" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "message_emergency_deadline_after_create" CHECK ("deadline_at" > "created_at"),
  CONSTRAINT "message_emergency_message_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_emergency_created_by_idx" ON "message_emergency" ("created_by", "created_at");--> statement-breakpoint
CREATE INDEX "message_emergency_created_idx" ON "message_emergency" ("organization_id", "created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_emergency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'message_emergency_immutable: an emergency is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_emergency_actor: an emergency is recorded only by its author' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the author of a live message may declare it an emergency; channel_id is derived, not trusted.
  SELECT m.channel_id INTO NEW.channel_id
    FROM message m
   WHERE m.organization_id = NEW.organization_id AND m.id = NEW.message_id
     AND m.deleted_at IS NULL AND m.author_user_id = v_actor;
  IF NEW.channel_id IS NULL THEN
    RAISE EXCEPTION 'message_emergency_message: only the author of a live message may declare it an emergency' USING ERRCODE = 'check_violation';
  END IF;
  -- The database clock decides both instants; the deadline is not client-chosen.
  NEW.created_at := now();
  NEW.deadline_at := now() + interval '15 minutes';
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_emergency_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "message_emergency"
  FOR EACH ROW EXECUTE FUNCTION message_emergency_guard();--> statement-breakpoint

CREATE TABLE "message_emergency_recipient" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "emergency_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id"),
  "acknowledged_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_emergency_recipient_unique" UNIQUE ("emergency_id", "user_id"),
  CONSTRAINT "message_emergency_recipient_emergency_fk"
    FOREIGN KEY ("organization_id", "emergency_id")
    REFERENCES "message_emergency"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_emergency_recipient_waiting_idx" ON "message_emergency_recipient" ("organization_id", "user_id") WHERE "acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_emergency_recipient_user_fk_idx" ON "message_emergency_recipient" ("user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_emergency_recipient_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'message_emergency_recipient_immutable: the audience is never reduced' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The audience is written by the author, in the same transaction that created the emergency (so it is frozen at send), never
    -- includes the author, and starts unacknowledged.
    IF NOT EXISTS (
      SELECT 1 FROM message_emergency e
       WHERE e.organization_id = NEW.organization_id AND e.id = NEW.emergency_id
         AND e.created_by = v_actor AND e.created_by <> NEW.user_id
         AND e.created_at = now()) THEN
      RAISE EXCEPTION 'message_emergency_recipient_audience: the audience is set by the author at send and never includes them' USING ERRCODE = 'check_violation';
    END IF;
    NEW.acknowledged_at := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: one move only, NULL -> the database clock, by that person themself.
  IF (to_jsonb(NEW) - 'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_at') THEN
    RAISE EXCEPTION 'message_emergency_recipient_immutable: only the acknowledgment instant is set' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'message_emergency_recipient_once: an acknowledgment is recorded once and never withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_emergency_recipient_self: only the person themself acknowledges' USING ERRCODE = 'check_violation';
  END IF;
  NEW.acknowledged_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_emergency_recipient_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "message_emergency_recipient"
  FOR EACH ROW EXECUTE FUNCTION message_emergency_recipient_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads and inserts; only the acknowledgment instant updates; nothing deletes.
ALTER TABLE "message_emergency" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_emergency" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_emergency_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_emergency_recipient" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_emergency_org_isolation" ON "message_emergency"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_emergency_recipient_org_isolation" ON "message_emergency_recipient"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_emergency" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_emergency_recipient" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("acknowledged_at") ON "message_emergency_recipient" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern. Rows hold ids and instants only.
CREATE OR REPLACE FUNCTION audit_phi_write_message_emergency() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_message_emergency() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_emergency"
  AFTER INSERT OR UPDATE OR DELETE ON message_emergency
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_emergency('message_emergency');--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_emergency_recipient"
  AFTER INSERT OR UPDATE OR DELETE ON message_emergency_recipient
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_emergency('message_emergency_recipient');
