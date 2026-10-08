-- M29 §4.11.5 / D17 (GAP-043) — persist the listener circuit-breaker state with the hourly feed-health rollup.
--
-- `external_feed_health` was never written, so `evaluateListenerCircuit` had no previous state to advance and
-- `listener_down` could never fire. The health sweep now upserts one row per feed per hour and carries the
-- breaker state (`closed` | `open` | `half_open`) on it; the latest row per feed is the current state. Existing
-- rows (none are written today) default to `closed`. The table keeps its RLS, FORCE and audit trigger from 0148.
-- Idempotent.
ALTER TABLE "external_feed_health"
  ADD COLUMN IF NOT EXISTS "listener_circuit_state" text NOT NULL DEFAULT 'closed';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_external_feed_health_circuit_state'
  ) THEN
    ALTER TABLE "external_feed_health"
      ADD CONSTRAINT "chk_external_feed_health_circuit_state"
      CHECK ("listener_circuit_state" IN ('closed', 'open', 'half_open'));
  END IF;
END $$;
