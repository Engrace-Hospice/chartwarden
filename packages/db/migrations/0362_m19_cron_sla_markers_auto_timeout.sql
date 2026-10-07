-- M19 §4.8 — the four non-Tier-1 crons (`callback-sla`, `awaiting-callback-timeout`, `close-documented`,
-- `escalation-sla`; GAP-057 follow-up). Additive and idempotent.
--
-- 1. `triage_call.callback_sla_breached_at` — the idempotency marker of `callback-sla.cron`: a breach is
--    published once per `awaiting_callback` entry (re-armed by comparing it with the call's latest entry
--    into that state), so a one-minute tick does not re-page the same call every minute.
-- 2. `triage_escalation.sla_breached_at` — the pacing marker of `escalation-sla`: an unacknowledged breach
--    re-pages at most every 30 minutes.
-- 3. `triage_call_state_history.auto_timeout` — spec §4.8: the timeout transition is "recorded in state
--    history with `auto_timeout=true`".
-- 4. The §2.3 forward-transition whitelist gains `awaiting_callback → disposition_pending` (the timeout
--    edge, §4.8). Same function body as 0108 plus that one target; `abandoned` and the resume edge stand.
ALTER TABLE "triage_call" ADD COLUMN IF NOT EXISTS "callback_sla_breached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "triage_escalation" ADD COLUMN IF NOT EXISTS "sla_breached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "triage_call_state_history" ADD COLUMN IF NOT EXISTS "auto_timeout" boolean NOT NULL DEFAULT false;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m19_enforce_triage_call_forward_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.state::text
    WHEN 'open' THEN ARRAY['protocol_in_progress','abandoned']
    WHEN 'protocol_in_progress' THEN ARRAY['disposition_pending','awaiting_callback','abandoned']
    -- The caller rang back (resume), or the §4.8 awaiting-callback-timeout cron gave up waiting.
    WHEN 'awaiting_callback' THEN ARRAY['protocol_in_progress','disposition_pending','abandoned']
    WHEN 'disposition_pending' THEN ARRAY['documented_pending_encounter','escalated_unresolved','abandoned']
    WHEN 'documented_pending_encounter' THEN ARRAY['documented','abandoned']
    WHEN 'escalated_unresolved' THEN ARRAY['documented_pending_encounter','abandoned']
    WHEN 'documented' THEN ARRAY['closed']
    ELSE ARRAY[]::text[]  -- closed / abandoned are terminal
  END;

  IF NOT (NEW.state::text = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'M19_ILLEGAL_TRANSITION: triage_call % cannot move from % to % (§2.2.1)', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;
