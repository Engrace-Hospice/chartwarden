-- M36 WP 4.12 follow-on (ADR-0081, PROPOSED) - role-based send ("message the on-call RN"). One permission, one nullable column, one guard.
--   1. messaging.oncall.send: may address a ROLE. It changes who is paged, so it is granted to NO tenant role here (full-catalog admin
--      roles receive it through the template materialisation); the clinical lead names who may hold it. The tenant flag
--      messaging.role_send (absent = off) gates the routes.
--   2. message_acknowledgment_request.addressed_role: the ROLE the sender addressed ('rn' or 'physician'), NULL for a request that named a
--      person. The resolved person is the request's assigned_user_id at creation (and the `requested` event's assigned_user_id after any
--      reassign), so the request records both the role and the person it resolved to. A closed set, no free text, no PHI.
--   3. A role is fixed once recorded: a separate trigger (the 1126 update guard is untouched) refuses any change of addressed_role.
--      The name starts with message_ack_request so the service maps a race on it to the same conflict answer as the other ack guards.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.oncall.send', 'oncall_role_send', 'send', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

ALTER TABLE "message_acknowledgment_request" ADD COLUMN "addressed_role" text;--> statement-breakpoint
ALTER TABLE "message_acknowledgment_request" ADD CONSTRAINT "message_ack_request_addressed_role"
  CHECK ("addressed_role" IS NULL OR "addressed_role" IN ('rn', 'physician'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_ack_request_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'message_ack_request_role_immutable: the role a request was addressed to is fixed'
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "message_ack_request_role_guard"
  BEFORE UPDATE ON "message_acknowledgment_request"
  FOR EACH ROW WHEN (NEW."addressed_role" IS DISTINCT FROM OLD."addressed_role")
  EXECUTE FUNCTION message_ack_request_role_guard();
