-- M36 WP 2.4 - reactions and pins.
--
-- message_reaction: one row per (message, user, emoji). NON-CLINICAL: a reaction is a social signal, never a read
--   receipt or an acknowledgement, and this table is deliberately separate from message_receipt (whose `ack` status
--   was retired in 1079). The emoji is a key from a closed palette (packages/types messaging-reactions.ts), CHECKed
--   here so a direct INSERT cannot invent one; widening the palette is a migration.
-- message_pin: one row per pinned message, one pin per message per channel, who pinned it and when.
--
-- Both carry organization_id directly and reference the message through (organization_id, channel_id, message_id) ->
-- message(organization_id, channel_id, id) (the unique key 1083 added), so the database refuses a reaction or pin whose
-- channel is not the message's channel, or whose org is not the message's org - an FK check bypasses RLS, a composite
-- FK cannot. Both are FORCE-RLS on app.org_id with the NULLIF guard (an unset GUC matches nothing instead of
-- throwing), carry an actor-recording write-audit trigger (ids and timestamps only - no free text, no PHI, so no
-- scrub list; a pin/unpin therefore always leaves an audit_event row naming the actor), and grant wardenx_app only what it uses
-- (no UPDATE: a reaction or pin is created or deleted, never edited). wardenx_destruction can read/delete them so a
-- message destruction (ON DELETE CASCADE) is not blocked by FORCE RLS on the child rows.
--
-- Index coverage (test:fk-indexes:live): the message edge is led by the unique key / the explicit index below; the user
-- edges point at the soft-deleted `user` parent (exempt from the rule, no index). The unique keys also serve the per-message reaction count and the
-- "pins of a channel" read.

CREATE TABLE "message_reaction" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "emoji" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_reaction_message_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id", "message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_reaction_emoji_check"
    CHECK ("emoji" IN ('heart', 'thanks', 'smile', 'celebrate', 'sad', 'hug')),
  CONSTRAINT "message_reaction_unique"
    UNIQUE ("organization_id", "message_id", "user_id", "emoji")
);--> statement-breakpoint
CREATE INDEX "message_reaction_channel_message_idx"
  ON "message_reaction" ("organization_id", "channel_id", "message_id");--> statement-breakpoint

CREATE TABLE "message_pin" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "pinned_by_user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_pin_message_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id", "message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_pin_unique" UNIQUE ("organization_id", "channel_id", "message_id")
);--> statement-breakpoint

ALTER TABLE "message_reaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_reaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_reaction_org_isolation" ON "message_reaction"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_reaction_destruction" ON "message_reaction"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "message_reaction" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_reaction" TO wardenx_destruction;--> statement-breakpoint

ALTER TABLE "message_pin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_pin" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_pin_org_isolation" ON "message_pin"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_pin_destruction" ON "message_pin"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "message_pin" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_pin" TO wardenx_destruction;--> statement-breakpoint

-- The write-audit function records the ACTOR (app.user_id), not just the row: for an unpin the row's own
-- pinned_by_user_id is the person who pinned it, so the generic wardenx_audit_trigger (actor_kind 'system', no user)
-- would not say who removed it. The rows hold ids and a timestamp only, so there is nothing to scrub.
CREATE OR REPLACE FUNCTION audit_phi_write_message_annotation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
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
ALTER FUNCTION audit_phi_write_message_annotation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_reaction"
  AFTER INSERT OR UPDATE OR DELETE ON message_reaction
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_annotation();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_pin"
  AFTER INSERT OR UPDATE OR DELETE ON message_pin
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_annotation();
