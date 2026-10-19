-- M36 gap closure part A (ADR-0078) - the supervisor reassign (G-2). Two changes, no new table, no new grant, no new enum value:
--   1. `message_acknowledgment_event.reason_code` (nullable text, a fixed non-clinical set, only on a `reassigned` event). A reassign by a
--      supervisor records WHY, from the set; a reassign by the sender or the assignee has none. No free text, no PHI.
--   2. The update guard of migration 1120 is replaced in full (CREATE OR REPLACE; the pin test now reads THIS definition) so that a
--      PERSON who is neither the sender nor the assignee may reassign, but ONLY when the application marked the transaction with
--      `app.ack_supervisor_reassign = 'on'` AND the request still waits (pending, escalated or failed_unreachable) AND the write is the
--      reassign itself (a return to pending with a new assignee). An acknowledged request still can be handed on only by its assignee;
--      acknowledge, resolve and cancel keep their actor rules (a supervisor can do none of them). The permission (`messaging.review`) is
--      decided by the application route; the database is a backstop against application bugs, not against a compromised role.
-- The event INSERT guard of 1107 is untouched: the event names the session's own user, so the supervisor is the recorded actor.
-- SECURITY DEFINER with a pinned search_path, like 1107's, 1114's and 1120's.

ALTER TABLE "message_acknowledgment_event" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "message_acknowledgment_event" ADD CONSTRAINT "message_ack_event_reason_code"
  CHECK ("reason_code" IS NULL OR (
    "event_type" = 'reassigned' AND "actor_kind" = 'user' AND "reason_code" IN
      ('assignee_unreachable', 'assignee_unable_to_sign_in', 'assignee_off_shift', 'coverage_change', 'workload', 'other_operational')));--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_ack_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_reassign boolean; v_legal boolean; v_actor text; v_escalation boolean; v_supervisor boolean;
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
  -- ADR-0078: a supervisor reassign is the one write by a non-party. It is a person's session (v_actor set) that the application marked
  -- with a transaction-local setting; the setting alone changes nothing the rules below do not also allow (see the supervisor block).
  v_supervisor := v_actor IS NOT NULL AND COALESCE(current_setting('app.ack_supervisor_reassign', true), '') = 'on';
  -- WP 4.4: an escalation is the TIMER's write (pending -> escalated, or a higher tier of an escalated request). It is never a
  -- person's: an empty actor is the only one that may write it.
  v_escalation := NEW.status = 'escalated' AND OLD.status IN ('pending', 'escalated');
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
  -- WP 4.5: `failed_unreachable` ("every route failed and nobody could be reached") is the delivery-failure handler's write. It is never a
  -- person's: an empty actor is the only one that may write it, so nobody can mark a request unreachable by hand (or hide behind it).
  IF NEW.status = 'failed_unreachable' AND OLD.status <> 'failed_unreachable' AND v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the delivery-failure handler marks a request unreachable' USING ERRCODE = 'check_violation';
  END IF;
  IF v_escalation AND v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the escalation timer escalates a request' USING ERRCODE = 'check_violation';
  END IF;
  -- The timer's recipient is never the sender, and its new window is a real one: it ends in the future and within the longest tier
  -- window (60 minutes, the important class's default). The class maximum from the CHECK still applies on top.
  IF v_escalation THEN
    IF NEW.assigned_user_id = NEW.requester_user_id THEN
      RAISE EXCEPTION 'message_ack_request_escalation: the sender cannot be the escalation recipient' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deadline_at <= now() OR NEW.deadline_at > now() + interval '60 minutes' THEN
      RAISE EXCEPTION 'message_ack_request_escalation: an escalation window ends within the next 60 minutes' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Who acts. Taking responsibility and closing are the ASSIGNED user's own acts (nobody acts on another person's behalf); a
  -- reassign is by a party; a cancel is the requester's (the author deleting the message). An empty actor is a system write.
  IF NEW.status IN ('acknowledged', 'resolved') AND OLD.status <> NEW.status
     AND v_actor IS DISTINCT FROM NEW.assigned_user_id::text THEN
    RAISE EXCEPTION 'message_ack_request_actor: only the assigned user acknowledges or resolves' USING ERRCODE = 'check_violation';
  END IF;
  IF v_supervisor AND (NOT v_reassign OR OLD.status NOT IN ('pending', 'escalated', 'failed_unreachable')) THEN
    RAISE EXCEPTION 'message_ack_request_actor: a supervisor reassigns only a request that still waits' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reassign AND v_actor IS NOT NULL AND NOT v_supervisor
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
  -- The assignee and the window move only when the request is (re)assigned or escalated; a new window only with a new assignee
  -- or a higher tier. An escalation hands the request to the tier's user (recorded here, never re-derived from a clock later).
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    IF NEW.status <> 'pending' AND NOT v_escalation THEN
      RAISE EXCEPTION 'message_ack_request_reassign: the assignee changes only by a reassign or an escalation' USING ERRCODE = 'check_violation';
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
  IF (NEW.window_started_at <> OLD.window_started_at) AND NOT (v_reassign OR v_escalation) THEN
    RAISE EXCEPTION 'message_ack_request_window: the window restarts only on a reassign or an escalation' USING ERRCODE = 'check_violation';
  END IF;
  IF (v_reassign OR v_escalation) AND (NEW.window_started_at < OLD.window_started_at
     OR abs(extract(epoch FROM (NEW.window_started_at - now()))) > 300) THEN
    RAISE EXCEPTION 'message_ack_request_window: a reassign starts a new window now' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deadline_at <> OLD.deadline_at AND NOT (v_reassign OR NEW.status = 'escalated') THEN
    RAISE EXCEPTION 'message_ack_request_window: the deadline moves only on a reassign or an escalation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
