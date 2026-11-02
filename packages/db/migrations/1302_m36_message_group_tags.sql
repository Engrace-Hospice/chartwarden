-- compat: contract
-- (Declared `contract` only because the gate reads any DROP/ADD CONSTRAINT that way, see migrations/README.md; this one WIDENS a CHECK, so the old
-- application keeps working: every value it writes is still allowed.)
-- M36 ADR-0107 (PROPOSED) - group tags (@role, @care-team, @on-call) in messages. The tenant flag messaging.group_tags (absent = off) gates the
-- application; nothing here changes behaviour while it is off.
--   * message_entity_reference.reference_kind: the CHECK is widened from ('staff','patient') to add 'role','team','on_call'. Additive: every
--     existing row satisfies the wider set, no data is rewritten, and an application rollback leaves the wider CHECK harmlessly in place.
--   * message_group_tag_recipient: the people a group tag resolved to AT SEND (ADR-0107 D3), one row per (tag, person). Written in the
--     sending transaction, insert-only (no UPDATE/DELETE grant; the guard refuses UPDATE, and DELETE unless the message itself is gone), ids and
--     instants only (no names, no text). It does not reference message_entity_reference: an edit rewrites those rows and must not touch the snapshot.
--     The application only writes users who are active members of the message's channel (D4); the snapshot is an audit record, not a
--     membership grant. There is no read route; RLS isolates organizations.
ALTER TABLE "message_entity_reference" DROP CONSTRAINT "message_entity_reference_kind_shape";--> statement-breakpoint
ALTER TABLE "message_entity_reference" ADD CONSTRAINT "message_entity_reference_kind_shape"
  CHECK ("reference_kind" IN ('staff', 'patient', 'role', 'team', 'on_call'));--> statement-breakpoint

CREATE TABLE "message_group_tag_recipient" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "tag_kind" text NOT NULL,
  "tag_entity_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_group_tag_recipient_unique" UNIQUE ("organization_id", "message_id", "tag_kind", "tag_entity_id", "user_id"),
  CONSTRAINT "message_group_tag_recipient_kind_shape" CHECK ("tag_kind" IN ('role', 'team', 'on_call')),
  CONSTRAINT "message_group_tag_recipient_message_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_group_tag_recipient_message_idx" ON "message_group_tag_recipient" ("organization_id", "message_id");--> statement-breakpoint
CREATE INDEX "message_group_tag_recipient_user_idx" ON "message_group_tag_recipient" ("user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_group_tag_recipient_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the cascade from a message that no longer exists may remove a row (the parent is already gone when its RI action runs).
    IF EXISTS (SELECT 1 FROM message m WHERE m.organization_id = OLD.organization_id AND m.id = OLD.message_id) THEN
      RAISE EXCEPTION 'message_group_tag_recipient_immutable: the resolved audience of a tag is never reduced' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'message_group_tag_recipient_immutable: the resolved audience of a tag is never changed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_group_tag_recipient_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "message_group_tag_recipient"
  FOR EACH ROW EXECUTE FUNCTION message_group_tag_recipient_guard();--> statement-breakpoint

ALTER TABLE "message_group_tag_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_group_tag_recipient" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_group_tag_recipient_org_isolation" ON "message_group_tag_recipient"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_group_tag_recipient" TO chartwarden_app;--> statement-breakpoint

-- The generic 1300 PHI audit function (its table name is the trigger argument). Rows hold ids and instants only.
CREATE TRIGGER "trg_audit_message_group_tag_recipient"
  AFTER INSERT OR UPDATE OR DELETE ON message_group_tag_recipient
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_emergency('message_group_tag_recipient');
