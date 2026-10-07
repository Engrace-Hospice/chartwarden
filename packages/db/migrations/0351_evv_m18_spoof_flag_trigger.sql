-- 0351 (GAP-056) — let the M18 `gps-spoof-detector` worker flag an `evv_event` as suspected_spoof.
--
-- 0047's append-only trigger refuses every UPDATE except the two supersede markers, so the §4.8
-- `m18.gps-spoof-detector` (D9 — advisory flag, never a block) could never set
-- `gps_quality = 'suspected_spoof'`: the heuristic had nowhere to write. This narrows the exception by exactly one
-- transition: `gps_quality` may change, and ONLY to 'suspected_spoof' (the advisory flag; it never moves to any
-- other value, so the captured evidence itself — coordinates, timestamps, accuracy, device — stays immutable).
-- Idempotent (CREATE OR REPLACE); the trigger itself is unchanged.--> statement-breakpoint
CREATE OR REPLACE FUNCTION evv_event_enforce_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_cmp jsonb;
  new_cmp jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_NO_DELETE';
  END IF;
  old_cmp := to_jsonb(OLD) - 'superseded_at' - 'superseded_by_event_id';
  new_cmp := to_jsonb(NEW) - 'superseded_at' - 'superseded_by_event_id';
  IF NEW.gps_quality = 'suspected_spoof' AND OLD.gps_quality IS DISTINCT FROM NEW.gps_quality THEN
    old_cmp := old_cmp - 'gps_quality';
    new_cmp := new_cmp - 'gps_quality';
  END IF;
  IF new_cmp IS DISTINCT FROM old_cmp THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN';
  END IF;
  RETURN NEW;
END $$;
