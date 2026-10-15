-- M36 WP 4.2 - the acknowledgment-request aggregate (ADR-0069, extends ADR-0056). A request asks ONE named, qualified clinician
-- to take clinical responsibility for ONE message, and is closed by an explicit authenticated action; opening or reading a
-- message never touches it. `message_acknowledgment_event` is the append-only history (who did what, to what, when).
--
-- Ids, enums and instants only: no title, note or free text (the message is read through its own route). WP 4.2 stores the
-- request and exposes four transitions (create, acknowledge, reassign, resolve) plus cancel-on-delete; timers, tiers, routing,
-- overdue and delivery-failure handling are WP 4.3 - 4.5, so NOTHING in 4.2 writes `escalated`, `failed_unreachable`, `overdue`,
-- `delivery_failed`, `opened` or `delivered`. They are in the enums now so those packages cannot break the machine.
--
-- Rules the database enforces (the service checks them first, these are the backstop):
--   * ONE request per message (unique); the requester is the message's author; the assignee is an active member of the
--     organization and never the requester;
--   * a class `urgent` request belongs to an urgent message and names its recipient; `critical_symptom` has NO writer yet;
--   * the state machine: only the transitions in ADR-0069 D3 (BEFORE UPDATE trigger); resolved and cancelled are final;
--     immutable columns; version +1 on every change; `requested_at` never changes;
--   * acknowledged_by is the assignee (nobody acknowledges on another person's behalf);
--   * the deadline window is positive and never longer than the platform maximum for the class (CHECK), and a window can only
--     START at (about) the database's now(), so a forged start cannot stretch the deadline;
--   * who acts: acknowledge and resolve only as the assigned user (the session's app.user_id), reassign only as the requester
--     (before the request is taken) or the current assignee, cancel only as the requester; an empty app.user_id is a system write
--     (WP 4.4 / 4.5), never a user. NOTE: app.user_id is set by the application, so binding writes to it is a BACKSTOP against
--     application bugs (a code path acting as the wrong person), not a defence against a compromised application role, which
--     could set the setting to anything. Authentication and the service checks are the control; the audit trigger records it;
--   * every history event names the session's actor and the request's own resulting status (a forged event is refused);
--   * the event table takes INSERT only (UPDATE refused for every role, DELETE only by the tenant-destruction role, including
--     the referential cascade from a request or message it erases);
--   * a message cannot be tombstoned while its request is open, and cannot be edited once a request exists.
-- wardenx_app has NO DELETE (lifecycle-no-delete gate); wardenx_destruction may DELETE for tenant destruction / the eraser.
-- Tenancy: organization_id plus a server-derived patient_id (a logical pointer); M36 carries no provider/location, so those
-- columns of the three-column rule are not modelled (like clinical_handoff).

CREATE TYPE "message_ack_status" AS ENUM
  ('pending', 'acknowledged', 'escalated', 'resolved', 'cancelled', 'failed_unreachable');--> statement-breakpoint
CREATE TYPE "message_ack_class" AS ENUM ('important', 'urgent', 'critical_symptom');--> statement-breakpoint
CREATE TYPE "message_ack_event_type" AS ENUM
  ('requested', 'delivered', 'opened', 'acknowledged', 'overdue', 'escalated', 'reassigned', 'resolved', 'cancelled',
   'delivery_failed');--> statement-breakpoint

CREATE TABLE "message_acknowledgment_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "ack_class" "message_ack_class" NOT NULL,
  "status" "message_ack_status" DEFAULT 'pending' NOT NULL,
  "requester_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "assigned_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "window_started_at" timestamptz DEFAULT now() NOT NULL,
  "deadline_at" timestamptz NOT NULL,
  "current_tier" integer DEFAULT 0 NOT NULL,
  "acknowledged_at" timestamptz,
  "acknowledged_by_user_id" uuid REFERENCES "user"("id"),
  "resolved_at" timestamptz,
  "resolved_by_user_id" uuid REFERENCES "user"("id"),
  "cancelled_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_ack_request_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_ack_request_one_per_message" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "message_ack_request_message_fk"
    FOREIGN KEY ("organization_id", "channel_id", "message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_ack_request_parties" CHECK ("assigned_user_id" <> "requester_user_id"),
  CONSTRAINT "message_ack_request_window" CHECK (
    "deadline_at" > "window_started_at"
    AND "window_started_at" >= "requested_at"
    -- The platform maximum per class (ADR-0056 D4). Pinned to ACK_DEADLINE_POLICY in @wardenx/types by a test.
    AND "deadline_at" <= "window_started_at" + (CASE "ack_class"
      WHEN 'important' THEN interval '120 minutes'
      WHEN 'urgent' THEN interval '30 minutes'
      WHEN 'critical_symptom' THEN interval '10 minutes' END)),
  CONSTRAINT "message_ack_request_tier" CHECK (
    "current_tier" >= 0
    AND ("status" <> 'pending' OR "current_tier" = 0)
    AND ("status" <> 'escalated' OR "current_tier" >= 1)),
  CONSTRAINT "message_ack_request_version" CHECK ("version" >= 0),
  -- Open-and-waiting states carry no outcome; the outcome columns move together and with the status.
  CONSTRAINT "message_ack_request_waiting_shape" CHECK (
    "status" NOT IN ('pending', 'escalated', 'failed_unreachable')
    OR ("acknowledged_at" IS NULL AND "resolved_at" IS NULL AND "cancelled_at" IS NULL)),
  CONSTRAINT "message_ack_request_ack_shape" CHECK (
    ("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL)
    AND ("status" <> 'acknowledged' OR "acknowledged_at" IS NOT NULL)
    AND ("acknowledged_by_user_id" IS NULL OR "acknowledged_by_user_id" = "assigned_user_id")),
  CONSTRAINT "message_ack_request_resolved_shape" CHECK (
    ("status" = 'resolved') = ("resolved_at" IS NOT NULL)
    AND ("resolved_at" IS NULL) = ("resolved_by_user_id" IS NULL)
    AND ("resolved_by_user_id" IS NULL OR "resolved_by_user_id" = "assigned_user_id")),
  CONSTRAINT "message_ack_request_cancelled_shape" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
);--> statement-breakpoint
-- The composite message FK's covering index (test:fk-indexes:live) - also the "requests in this channel" read.
CREATE INDEX "message_ack_request_message_idx"
  ON "message_acknowledgment_request" ("organization_id", "channel_id", "message_id");--> statement-breakpoint
CREATE INDEX "message_ack_request_assignee_idx"
  ON "message_acknowledgment_request" ("organization_id", "assigned_user_id", "status", "deadline_at");--> statement-breakpoint
CREATE INDEX "message_ack_request_requester_idx"
  ON "message_acknowledgment_request" ("organization_id", "requester_user_id", "status");--> statement-breakpoint
-- What WP 4.4's timer and WP 4.9's unacknowledged queue will read: every open request by deadline.
CREATE INDEX "message_ack_request_open_deadline_idx"
  ON "message_acknowledgment_request" ("organization_id", "deadline_at")
  WHERE "status" IN ('pending', 'escalated', 'failed_unreachable');--> statement-breakpoint

CREATE TABLE "message_acknowledgment_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "request_id" uuid NOT NULL,
  "event_type" "message_ack_event_type" NOT NULL,
  "actor_user_id" uuid,
  "actor_kind" text NOT NULL,
  "from_status" "message_ack_status",
  "to_status" "message_ack_status",
  "assigned_user_id" uuid,
  "previous_assigned_user_id" uuid,
  "tier" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_ack_event_request_fk"
    FOREIGN KEY ("organization_id", "request_id")
    REFERENCES "message_acknowledgment_request"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_ack_event_actor_shape"
    CHECK ("actor_kind" IN ('user', 'system') AND (("actor_kind" = 'system') = ("actor_user_id" IS NULL))),
  CONSTRAINT "message_ack_event_tier" CHECK ("tier" >= 0)
);--> statement-breakpoint
CREATE INDEX "message_ack_event_request_idx"
  ON "message_acknowledgment_event" ("organization_id", "request_id", "created_at");--> statement-breakpoint

-- INSERT guard: a request is BORN pending, version 0, tier 0, with a fresh window, about a live message its requester wrote.
-- An `urgent` request belongs to an urgent message and names its recipient; `critical_symptom` has no writer in WP 4.2.
-- The assignee must hold an ACTIVE membership of the organization (the app checks the full qualification first). A row that
-- already exists for this message is left to the ON CONFLICT of the caller (a replay must not be refused here).
CREATE OR REPLACE FUNCTION message_ack_request_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_author uuid; v_status text; v_urgency text; v_recipient uuid; v_channel uuid; v_kind text; v_subject uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM message_acknowledgment_request r
              WHERE r.organization_id = NEW.organization_id AND r.message_id = NEW.message_id) THEN
    RETURN NEW;
  END IF;
  -- A window starts now: the platform maximum is relative to its start, so a forged start would stretch the deadline.
  IF abs(extract(epoch FROM (NEW.requested_at - now()))) > 300 THEN
    RAISE EXCEPTION 'message_ack_request: a request starts now' USING ERRCODE = 'check_violation';
  END IF;
  -- The patient is the channel's: a patient care-team channel, and the request names ITS subject (never a caller's guess).
  SELECT c.channel_kind::text, c.subject_id INTO v_kind, v_subject
    FROM channel c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.channel_id;
  IF v_kind IS DISTINCT FROM 'care_team' OR v_subject IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'message_ack_request: the patient is the care-team channel''s patient' USING ERRCODE = 'check_violation';
  END IF;
  SELECT m.author_user_id, m.status::text, m.urgency::text, m.urgent_recipient_user_id, m.channel_id
    INTO v_author, v_status, v_urgency, v_recipient, v_channel
    FROM message m WHERE m.organization_id = NEW.organization_id AND m.id = NEW.message_id
    FOR SHARE OF m; -- serialises with a concurrent delete or edit of the message (their row lock conflicts)
  IF v_author IS NULL OR v_status = 'deleted' OR v_channel IS DISTINCT FROM NEW.channel_id THEN
    RAISE EXCEPTION 'message_ack_request: the message is missing or deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.requester_user_id IS DISTINCT FROM v_author THEN
    RAISE EXCEPTION 'message_ack_request: only the message author requests a response' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'pending' OR NEW.version <> 0 OR NEW.current_tier <> 0
     OR NEW.window_started_at <> NEW.requested_at THEN
    RAISE EXCEPTION 'message_ack_request: a request is created pending in its first window' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ack_class = 'critical_symptom' THEN
    RAISE EXCEPTION 'message_ack_request: the critical class has no writer yet' USING ERRCODE = 'check_violation';
  END IF;
  IF (v_urgency = 'urgent') <> (NEW.ack_class = 'urgent')
     OR (v_urgency = 'urgent' AND NEW.assigned_user_id IS DISTINCT FROM v_recipient) THEN
    RAISE EXCEPTION 'message_ack_request: the class follows the message urgency and its named recipient'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM membership mb
                  WHERE mb.user_id = NEW.assigned_user_id AND mb.organization_id = NEW.organization_id
                    AND mb.status = 'active') THEN
    RAISE EXCEPTION 'message_ack_request: the assignee is not an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_request_insert_guard"
  BEFORE INSERT ON "message_acknowledgment_request"
  FOR EACH ROW EXECUTE FUNCTION message_ack_request_insert_guard();--> statement-breakpoint

-- UPDATE guard = the state machine of ADR-0069 D3 (the same table is in @wardenx/messaging, pinned by a test).
CREATE OR REPLACE FUNCTION message_ack_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_reassign boolean; v_legal boolean; v_actor text;
BEGIN
  IF OLD.status IN ('resolved', 'cancelled') THEN
    RAISE EXCEPTION 'message_ack_request_final: a % request cannot be changed', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.message_id <> OLD.message_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.patient_id <> OLD.patient_id OR NEW.ack_class <> OLD.ack_class
     OR NEW.requester_user_id <> OLD.requester_user_id OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'message_ack_request_immutable: identity, class, requester and requested_at are fixed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'message_ack_request_version: every change increases the version by one' USING ERRCODE = 'check_violation';
  END IF;
  v_reassign := NEW.status = 'pending';
  v_actor := NULLIF(current_setting('app.user_id', true), '');
  IF NEW.status = OLD.status THEN
    -- Only two same-status updates exist: a reassign of a pending request, a higher tier of an escalated one.
    v_legal := (OLD.status = 'pending' AND NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id)
            OR (OLD.status = 'escalated' AND NEW.current_tier > OLD.current_tier);
  ELSE
    v_legal := CASE OLD.status
      WHEN 'pending' THEN NEW.status IN ('acknowledged', 'escalated', 'failed_unreachable', 'cancelled')
      WHEN 'escalated' THEN NEW.status IN ('acknowledged', 'failed_unreachable', 'cancelled', 'pending')
      WHEN 'acknowledged' THEN NEW.status IN ('resolved', 'pending', 'cancelled')
      WHEN 'failed_unreachable' THEN NEW.status IN ('acknowledged', 'resolved', 'pending', 'cancelled')
      ELSE false END;
  END IF;
  IF NOT v_legal THEN
    RAISE EXCEPTION 'message_ack_request_transition: % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Who acts. Taking responsibility and closing are the ASSIGNED user's own acts (nobody acts on another person's behalf); a
  -- reassign is by a party; a cancel is the requester's (the author deleting the message). An empty actor is a system write.
  IF NEW.status IN ('acknowledged', 'resolved') AND OLD.status <> NEW.status
     AND v_actor IS DISTINCT FROM NEW.assigned_user_id::text THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the assigned user acknowledges or resolves' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reassign AND v_actor IS NOT NULL
     AND v_actor NOT IN (OLD.requester_user_id::text, OLD.assigned_user_id::text) THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the sender or the assignee reassigns' USING ERRCODE = 'check_violation';
  END IF;
  -- Once the assignee took responsibility only the assignee hands it on: the sender cannot take it back from under them.
  IF v_reassign AND OLD.status = 'acknowledged' AND v_actor IS NOT NULL AND v_actor <> OLD.assigned_user_id::text THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the person who took responsibility hands it on' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'cancelled' AND v_actor IS NOT NULL AND v_actor <> OLD.requester_user_id::text THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the sender withdraws a request' USING ERRCODE = 'check_violation';
  END IF;
  -- The record of who took responsibility is frozen once written: only a return to pending (a reassign) clears it.
  IF NEW.status <> 'pending' AND (
       (OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
          OR NEW.acknowledged_by_user_id IS DISTINCT FROM OLD.acknowledged_by_user_id))
    OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at)) THEN
    RAISE EXCEPTION 'message_ack_request_record: an acknowledgment cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  -- The assignee and the window move only when the request is (re)assigned; a new window only with a new assignee.
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'message_ack_request_reassign: the assignee changes only by a reassign' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM membership mb
                    WHERE mb.user_id = NEW.assigned_user_id AND mb.organization_id = NEW.organization_id
                      AND mb.status = 'active') THEN
      RAISE EXCEPTION 'message_ack_request: the assignee is not an active member of the organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_reassign AND NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id THEN
    RAISE EXCEPTION 'message_ack_request_reassign: a return to pending needs a new assignee' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.window_started_at <> OLD.window_started_at) AND NOT v_reassign THEN
    RAISE EXCEPTION 'message_ack_request_window: the window restarts only on a reassign' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reassign AND (NEW.window_started_at < OLD.window_started_at
     OR abs(extract(epoch FROM (NEW.window_started_at - now()))) > 300) THEN
    RAISE EXCEPTION 'message_ack_request_window: a reassign starts a new window now' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deadline_at <> OLD.deadline_at AND NOT (v_reassign OR NEW.status = 'escalated') THEN
    RAISE EXCEPTION 'message_ack_request_window: the deadline moves only on a reassign or an escalation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_request_update_guard"
  BEFORE UPDATE ON "message_acknowledgment_request"
  FOR EACH ROW EXECUTE FUNCTION message_ack_request_update_guard();--> statement-breakpoint

-- Event history is append-only: no UPDATE for any role (a superuser included); DELETE only for tenant destruction (the erasure
-- path, including the ON DELETE CASCADE from a request or message it removes). A referential cascade runs as the OWNER of the
-- history table, so `current_user` is not the destruction role there; the role the SESSION connected as (session_user) or
-- SET ROLE'd to (the `role` setting) survives the cascade. A superuser login is excluded as a plain session_user: it is a
-- member of every role, so membership alone proves nothing. wardenx_app is not a member and has no DELETE on either table.
CREATE OR REPLACE FUNCTION message_ack_event_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       current_user = 'wardenx_destruction'
    OR current_setting('role', true) = 'wardenx_destruction'
    OR (pg_has_role(session_user, 'wardenx_destruction', 'MEMBER')
        AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user))) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'message_ack_event_append_only: the history cannot be changed or removed' USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_event_append_only"
  BEFORE UPDATE OR DELETE ON "message_acknowledgment_event"
  FOR EACH ROW EXECUTE FUNCTION message_ack_event_append_only();--> statement-breakpoint

-- INSERT guard: an event is written AFTER its request's own change in the same transaction, so it must name the session's actor
-- (a user event the user of the session; a system event only when the session has no user) and the request's resulting status. A
-- forged event - another person's name, or a status the request is not in - is refused. A backstop against application bugs (see
-- the header), not against a compromised application role. Runs as the caller: the request is read under the same RLS.
CREATE OR REPLACE FUNCTION message_ack_event_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor text; v_status message_ack_status;
BEGIN
  v_actor := NULLIF(current_setting('app.user_id', true), '');
  IF NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id::text IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_ack_event_actor: an event names the session''s own user' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.actor_user_id IS NULL AND v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'message_ack_event_actor: a system event cannot be written from a user session' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.status INTO v_status FROM message_acknowledgment_request r
   WHERE r.organization_id = NEW.organization_id AND r.id = NEW.request_id;
  IF NEW.to_status IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION 'message_ack_event_status: an event records the request''s own resulting status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_event_insert_guard"
  BEFORE INSERT ON "message_acknowledgment_event"
  FOR EACH ROW EXECUTE FUNCTION message_ack_event_insert_guard();--> statement-breakpoint

-- A message with an OPEN request cannot be tombstoned (the delete path cancels the request first), and a message that has a
-- request (not cancelled) cannot be edited: a correction is a new linked message (ADR-0056 D8). Body re-encryption and other
-- updates that change neither status nor edited_at are untouched.
CREATE OR REPLACE FUNCTION message_ack_request_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status <> 'deleted' AND EXISTS (
    SELECT 1 FROM message_acknowledgment_request r
     WHERE r.organization_id = OLD.organization_id AND r.message_id = OLD.id
       AND r.status IN ('pending', 'acknowledged', 'escalated', 'failed_unreachable')) THEN
    RAISE EXCEPTION 'message_ack_request_open: cancel the open request before deleting the message'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.edited_at IS NOT NULL AND NEW.edited_at IS DISTINCT FROM OLD.edited_at AND EXISTS (
    SELECT 1 FROM message_acknowledgment_request r
     WHERE r.organization_id = OLD.organization_id AND r.message_id = OLD.id AND r.status <> 'cancelled') THEN
    RAISE EXCEPTION 'message_ack_request_edit: a message with a response request cannot be edited'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_ack_request_message_guard"
  BEFORE UPDATE ON "message"
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.edited_at IS DISTINCT FROM OLD.edited_at)
  EXECUTE FUNCTION message_ack_request_message_guard();--> statement-breakpoint

ALTER TABLE "message_acknowledgment_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_acknowledgment_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_ack_request_org_isolation" ON "message_acknowledgment_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_acknowledgment_request" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("status", "assigned_user_id", "window_started_at", "deadline_at", "current_tier", "acknowledged_at",
              "acknowledged_by_user_id", "resolved_at", "resolved_by_user_id", "cancelled_at", "version", "updated_at")
  ON "message_acknowledgment_request" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "message_acknowledgment_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_acknowledgment_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_ack_event_org_isolation" ON "message_acknowledgment_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_acknowledgment_event" TO wardenx_app;--> statement-breakpoint

-- Event: ids, enums and instants only, so the generic trigger (no scrub list) fits.
CREATE TRIGGER "message_ack_event_audit" AFTER INSERT OR UPDATE OR DELETE ON message_acknowledgment_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- Request: bespoke trigger so the patient is recorded as changed without being copied into the immutable log. The actor is
-- the request user (app.user_id); a system write (cancel by the message's own transaction still carries the user) is "system".
CREATE OR REPLACE FUNCTION audit_phi_write_message_acknowledgment_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_acknowledgment_request.' || lower(TG_OP), 'message_acknowledgment_request',
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
ALTER FUNCTION audit_phi_write_message_acknowledgment_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_acknowledgment_request"
  AFTER INSERT OR UPDATE OR DELETE ON message_acknowledgment_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_acknowledgment_request();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_acknowledgment_request" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_ack_request_destruction" ON "message_acknowledgment_request"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "message_acknowledgment_event" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_ack_event_destruction" ON "message_acknowledgment_event"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
