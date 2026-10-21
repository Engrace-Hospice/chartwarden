-- M36 WP 4.10 (ADR-0077) - snooze and reminders. Two small, USER-OWNED tables. Neither carries text: ids and instants only.
--
-- message_snooze: one user's bounded pause of OUT-OF-BAND notices for the NON-URGENT alerts of one conversation. A row says
-- "until <instant> do not push / SMS / email me about this conversation"; the in-app alert and the unread state are never touched,
-- and the alerts that are urgent or acknowledgment-bound are not snoozable at all (the allowlist is in code, `SNOOZABLE_EVENT_TYPES`).
-- Two rules are backed here so a caller that skips the service still cannot break them:
--   * the length is bounded: 0 < snoozed_until - snoozed_at <= 24 hours (a re-snooze moves snoozed_at);
--   * a user who is the SENDER or the ASSIGNEE of an OPEN acknowledgment request in the conversation cannot snooze it (trigger).
--     An open request opened AFTER the snooze voids it for as long as it is open: the reader below never reports such a snooze.
--
-- message_reminder: one user's reminder on one NON-URGENT message. The message must be `routine` and have no open acknowledgment
-- request (trigger); the horizon is bounded: 0 < remind_at - set_at <= 30 days. The sweep deletes the row once the reminder alert
-- has been raised (the alert row is the durable record), so there is no "fired" state to stick.
--
-- Isolation: org policy AND owner, STRICT (the 1087 pattern): a context with no user reads, updates and deletes NOTHING. The two
-- system readers (the snooze lookup at alert-planning time and the reminder sweep's lister) are narrow SECURITY DEFINER functions
-- that return ids and instants for the session tenant only. Tenant erase rides the composite FKs (ON DELETE CASCADE) and
-- wardenx_destruction.

CREATE TABLE "message_snooze" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL,
  "snoozed_at" timestamptz DEFAULT now() NOT NULL,
  "snoozed_until" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_snooze_channel_org_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_snooze_one_per_channel" UNIQUE ("organization_id", "user_id", "channel_id"),
  -- The hard maximum (SNOOZE_MAX_MINUTES in @chartwarden/types, pinned by a test).
  CONSTRAINT "message_snooze_bounded" CHECK (
    "snoozed_until" > "snoozed_at" AND "snoozed_until" <= "snoozed_at" + interval '24 hours')
);--> statement-breakpoint

-- FK-index coverage (test:fk-indexes:live): (org, channel) for the channel FK, user_id for the user FK. The unique key above leads
-- with (organization_id, user_id, channel_id) and serves the owner's lookup.
CREATE INDEX "message_snooze_org_channel_idx" ON "message_snooze" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_snooze_user_idx" ON "message_snooze" ("user_id");--> statement-breakpoint

ALTER TABLE "message_snooze" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_snooze" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_snooze_owner_isolation" ON "message_snooze"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- Identity and owner are not updatable; only the window moves.
GRANT SELECT, INSERT, DELETE ON "message_snooze" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("snoozed_at", "snoozed_until", "updated_at") ON "message_snooze" TO wardenx_app;--> statement-breakpoint

-- Urgent / acknowledgment-bound conversations cannot be snoozed, whoever writes the row. Invoker rights: it reads the request table
-- under the caller's own org policy (message_ack_request_org_isolation).
CREATE OR REPLACE FUNCTION message_snooze_no_open_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM message_acknowledgment_request r
     WHERE r.organization_id = NEW.organization_id
       AND r.channel_id = NEW.channel_id
       AND r.status IN ('pending', 'acknowledged', 'escalated', 'failed_unreachable')
       AND (r.assigned_user_id = NEW.user_id OR r.requester_user_id = NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'message_snooze_urgent: a conversation with an open acknowledgment request cannot be snoozed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_snooze_no_open_request"
  BEFORE INSERT OR UPDATE ON "message_snooze"
  FOR EACH ROW EXECUTE FUNCTION message_snooze_no_open_request();--> statement-breakpoint

CREATE TRIGGER "trg_audit_message_snooze" AFTER INSERT OR UPDATE OR DELETE ON message_snooze
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- The planner's reader: "which of these users have an ACTIVE snooze of this conversation?". Owned by wardenx_admin, which gets a policy
-- for unexpired rows and a COLUMN grant, so it can return nothing more than it selects. It answers only for the org the session is bound
-- to, takes at most 500 ids, and returns user ids only. The open-request exclusion is applied by the caller (it reads the request table
-- under the tenant policy), so this function needs no grant on the request table.
CREATE POLICY "message_snooze_active_lister" ON "message_snooze"
  FOR SELECT TO wardenx_admin USING (snoozed_until > now());--> statement-breakpoint
GRANT SELECT ("organization_id", "user_id", "channel_id", "snoozed_until") ON "message_snooze" TO wardenx_admin;--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_snoozed_users_for_channel(
  p_organization_id uuid,
  p_channel_id uuid,
  p_user_ids jsonb
) RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_user_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_user_ids) > 500 THEN
    RAISE EXCEPTION 'p_user_ids must be a JSON array of at most 500 ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.user_id
  FROM message_snooze s
  WHERE s.organization_id = p_organization_id
    AND p_organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND s.channel_id = p_channel_id
    AND s.snoozed_until > now()
    AND s.user_id IN (SELECT (jsonb_array_elements_text(p_user_ids))::uuid);
END $$;--> statement-breakpoint
ALTER FUNCTION message_snoozed_users_for_channel(uuid, uuid, jsonb) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION message_snoozed_users_for_channel(uuid, uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION message_snoozed_users_for_channel(uuid, uuid, jsonb) TO wardenx_app;--> statement-breakpoint

GRANT SELECT, DELETE ON "message_snooze" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_snooze_destruction" ON "message_snooze"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- ---- reminders -------------------------------------------------------------------------------------------------------------

CREATE TABLE "message_reminder" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "set_at" timestamptz DEFAULT now() NOT NULL,
  "remind_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_reminder_message_fk"
    FOREIGN KEY ("organization_id", "channel_id", "message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_reminder_one_per_message" UNIQUE ("organization_id", "user_id", "message_id"),
  -- The hard horizon (REMINDER_MAX_HORIZON_DAYS in @chartwarden/types, pinned by a test).
  CONSTRAINT "message_reminder_bounded" CHECK (
    "remind_at" > "set_at" AND "remind_at" <= "set_at" + interval '30 days')
);--> statement-breakpoint

-- The sweep's lookup (due rows of one org), FK coverage for the message FK, and the user FK.
CREATE INDEX "message_reminder_due_idx" ON "message_reminder" ("organization_id", "remind_at");--> statement-breakpoint
CREATE INDEX "message_reminder_org_channel_message_idx" ON "message_reminder" ("organization_id", "channel_id", "message_id");--> statement-breakpoint
CREATE INDEX "message_reminder_user_idx" ON "message_reminder" ("user_id");--> statement-breakpoint

ALTER TABLE "message_reminder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_reminder" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_reminder_owner_isolation" ON "message_reminder"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "message_reminder" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("set_at", "remind_at", "updated_at") ON "message_reminder" TO wardenx_app;--> statement-breakpoint

-- A reminder is for a NON-URGENT message: `routine`, and no open acknowledgment request on it. Fail closed: a message the caller's
-- policy cannot read is refused too.
CREATE OR REPLACE FUNCTION message_reminder_non_urgent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_urgency text;
BEGIN
  SELECT m.urgency::text INTO v_urgency
    FROM message m
   WHERE m.organization_id = NEW.organization_id AND m.channel_id = NEW.channel_id AND m.id = NEW.message_id;
  IF v_urgency IS DISTINCT FROM 'routine' OR EXISTS (
    SELECT 1 FROM message_acknowledgment_request r
     WHERE r.organization_id = NEW.organization_id
       AND r.message_id = NEW.message_id
       AND r.status IN ('pending', 'acknowledged', 'escalated', 'failed_unreachable')
  ) THEN
    RAISE EXCEPTION 'message_reminder_urgent: a reminder can only be set on a non-urgent message'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_reminder_non_urgent"
  BEFORE INSERT OR UPDATE ON "message_reminder"
  FOR EACH ROW EXECUTE FUNCTION message_reminder_non_urgent();--> statement-breakpoint

CREATE TRIGGER "trg_audit_message_reminder" AFTER INSERT OR UPDATE OR DELETE ON message_reminder
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- The sweep's lister (ids and instants only), pinned to the session tenant; the sweep then acts on each row under its owner's context.
CREATE POLICY "message_reminder_due_lister" ON "message_reminder"
  FOR SELECT TO wardenx_admin USING (remind_at <= now());--> statement-breakpoint
GRANT SELECT ("id", "organization_id", "user_id", "channel_id", "message_id", "remind_at") ON "message_reminder" TO wardenx_admin;--> statement-breakpoint
-- A dev database that ran the earlier 1125 still has the 2-argument overload; remove it so only the paged one exists.
DROP FUNCTION IF EXISTS message_reminder_due(uuid, integer);--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_reminder_due(p_organization_id uuid, p_limit integer, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, user_id uuid, channel_id uuid, message_id uuid, remind_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.id, r.user_id, r.channel_id, r.message_id, r.remind_at
  FROM message_reminder r
  WHERE r.organization_id = p_organization_id
    AND p_organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND r.remind_at <= now()
  ORDER BY r.remind_at, r.id
  LIMIT LEAST(GREATEST(p_limit, 0), 500) OFFSET LEAST(GREATEST(p_offset, 0), 10000);
$$;--> statement-breakpoint
ALTER FUNCTION message_reminder_due(uuid, integer, integer) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION message_reminder_due(uuid, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION message_reminder_due(uuid, integer, integer) TO wardenx_app;--> statement-breakpoint

GRANT SELECT, DELETE ON "message_reminder" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_reminder_destruction" ON "message_reminder"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
