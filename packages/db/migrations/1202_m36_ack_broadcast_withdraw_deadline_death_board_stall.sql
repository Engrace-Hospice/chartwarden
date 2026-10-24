-- M36 wave 4 follow-ups (ADR-0097 D13-D14, ADR-0098 D13; both PROPOSED). Flag-gated by the same tenant flags as 1200/1201; nothing here is
-- reachable while they are off. No new table, no new permission, no new policy: FORCEd RLS on app.org_id is unchanged.
--   * WP 6.8: message_ack_broadcast gains `deadline_at` (set once at creation, display only: no reminder, no escalation hangs off it) and
--     `withdrawn_at` (the author stops asking: NULL -> the database clock, once, by the creator, never undone). A withdrawn broadcast takes no
--     further acknowledgment (the recipient guard refuses it); acknowledgments already recorded are untouched.
--   * WP 6.9: death_board_item_event.reason_code may now be 'owner_ineligible' (an open item's owner lost eligibility outside offboarding and
--     the stall sweep flagged the item needs_owner; the owner column is not changed).
-- Audit rows keep carrying ids and instants only (the new columns are instants).

ALTER TABLE "message_ack_broadcast" ADD COLUMN "deadline_at" timestamptz;--> statement-breakpoint
ALTER TABLE "message_ack_broadcast" ADD COLUMN "withdrawn_at" timestamptz;--> statement-breakpoint
ALTER TABLE "message_ack_broadcast" ADD CONSTRAINT "message_ack_broadcast_deadline_after_create"
  CHECK ("deadline_at" IS NULL OR "deadline_at" > "created_at");--> statement-breakpoint
ALTER TABLE "message_ack_broadcast" ADD CONSTRAINT "message_ack_broadcast_withdrawn_after_create"
  CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" >= "created_at");--> statement-breakpoint

-- INSERT as in 1200, plus: a broadcast is born unwithdrawn and any deadline lies in the future (database clock). UPDATE: the one move is
-- withdrawn_at NULL -> now(), by the creator; every other column (deadline included) is frozen.
CREATE OR REPLACE FUNCTION message_ack_broadcast_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at') THEN
      RAISE EXCEPTION 'message_ack_broadcast_immutable: only the withdrawal instant is set' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL THEN
      RAISE EXCEPTION 'message_ack_broadcast_withdraw_once: a withdrawal is recorded once and never undone' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_ack_broadcast_withdraw_actor: only the creator withdraws a broadcast' USING ERRCODE = 'check_violation';
    END IF;
    NEW.withdrawn_at := now();
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_ack_broadcast_actor: a broadcast is recorded only by its creator' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_ack_broadcast_born_open: a broadcast is created unwithdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deadline_at IS NOT NULL AND NEW.deadline_at <= now() THEN
    RAISE EXCEPTION 'message_ack_broadcast_deadline: a deadline must lie in the future' USING ERRCODE = 'check_violation';
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

-- As 1200, plus: nobody acknowledges a withdrawn broadcast (the requirement no longer stands).
CREATE OR REPLACE FUNCTION message_ack_broadcast_recipient_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
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
  IF (to_jsonb(NEW) - 'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_at') THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_immutable: only the acknowledgment instant is set' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_once: an acknowledgment is recorded once and never withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_self: only the person themself acknowledges' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM message_ack_broadcast b
     WHERE b.organization_id = NEW.organization_id AND b.id = NEW.broadcast_id AND b.withdrawn_at IS NOT NULL) THEN
    RAISE EXCEPTION 'message_ack_broadcast_recipient_withdrawn: the requirement was withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  NEW.acknowledged_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint

-- The only column the app role may ever update on a broadcast.
GRANT UPDATE ("withdrawn_at") ON "message_ack_broadcast" TO chartwarden_app;--> statement-breakpoint

ALTER TABLE "death_board_item_event" DROP CONSTRAINT "death_board_item_event_reason_shape";--> statement-breakpoint
ALTER TABLE "death_board_item_event" ADD CONSTRAINT "death_board_item_event_reason_shape"
  CHECK ("reason_code" IS NULL OR "reason_code" IN ('creation', 'manual', 'supervisor', 'offboarding', 'owner_ineligible'));
