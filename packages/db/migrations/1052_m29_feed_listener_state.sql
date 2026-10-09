-- 1052 - M29 GAP-043: a listener-down detector that survives the listener process dying.
--
-- The health tick runs INSIDE the listener process (listener/health-sweep.ts). If that process crashes or is OOM-killed
-- no tick runs, no row is written and nothing pages; "is this feed bound in THIS process" cannot see its own death. The
-- decision therefore moves to a watcher in the worker process (listener/health-watch.ts) that reads two facts the
-- listener leaves behind, plus an active TCP probe and the newest inbound frame.
--
-- `external_feed_health` is keyed (feed_id, hour_bucket): one row per feed per HOUR. A heartbeat or an open/closed state
-- kept there would vanish at every hour rollover, so the per-feed facts live in their own one-row-per-feed table:
--   listener_heartbeat_at / listener_bound   written by the LISTENER every 30s tick (a fact, never a decision)
--   circuit_state / outage_opened_at         written by the WATCHER, in the same transaction as the outbox event it
--                                            publishes (state and event cannot diverge; a crashed watcher re-evaluates
--                                            from stored state)
-- The two writers touch disjoint columns. A 30s heartbeat must not write an audit row per feed per tick, so
-- the audit trigger is CHANGE-GATED instead (see the end of this file); the table holds no PHI.
--
-- Per-feed config (M29 spec 4.11.5): `listener_down_threshold_seconds` - a tenant may TIGHTEN the 5 minute platform
-- default down to 1 minute, never loosen it above 5 (so 60..300; NULL = the 5 minute default); `expected_quiet_windows` -
-- an array of {days, start, end, tz} during which silence is expected (validated by listener/quiet-window.ts at write time).
CREATE TABLE IF NOT EXISTS "external_feed_listener_state" (
  "feed_id" uuid PRIMARY KEY REFERENCES "external_feed"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "listener_heartbeat_at" timestamptz,
  "listener_bound" boolean NOT NULL DEFAULT false,
  "circuit_state" text NOT NULL DEFAULT 'closed',
  "outage_opened_at" timestamptz,
  "last_evaluated_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_external_feed_listener_state_circuit"
    CHECK ("circuit_state" IN ('closed', 'open', 'half_open'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_feed_listener_state_org"
  ON "external_feed_listener_state" ("organization_id");--> statement-breakpoint

ALTER TABLE "external_feed_listener_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_feed_listener_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "external_feed_listener_state_org" ON "external_feed_listener_state";--> statement-breakpoint
CREATE POLICY "external_feed_listener_state_org" ON "external_feed_listener_state"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "external_feed_listener_state" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "external_feed_listener_state" TO wardenx_admin;--> statement-breakpoint

ALTER TABLE "external_feed"
  ADD COLUMN IF NOT EXISTS "listener_down_threshold_seconds" integer,
  ADD COLUMN IF NOT EXISTS "expected_quiet_windows" jsonb;--> statement-breakpoint
ALTER TABLE "external_feed" DROP CONSTRAINT IF EXISTS "chk_external_feed_listener_down_threshold";--> statement-breakpoint
ALTER TABLE "external_feed"
  ADD CONSTRAINT "chk_external_feed_listener_down_threshold"
  CHECK ("listener_down_threshold_seconds" IS NULL OR "listener_down_threshold_seconds" BETWEEN 60 AND 300);--> statement-breakpoint
ALTER TABLE "external_feed" DROP CONSTRAINT IF EXISTS "chk_external_feed_expected_quiet_windows";--> statement-breakpoint
ALTER TABLE "external_feed"
  ADD CONSTRAINT "chk_external_feed_expected_quiet_windows"
  CHECK ("expected_quiet_windows" IS NULL
         OR (jsonb_typeof("expected_quiet_windows") = 'array' AND jsonb_array_length("expected_quiet_windows") <= 14));
--> statement-breakpoint

-- M4 write-audit (§3.6), CHANGE-GATED. The table is written every 30s per feed by the listener heartbeat; auditing every
-- tick would write one audit row per feed per tick. So the baseline trigger fires on INSERT, DELETE, and on an UPDATE only
-- when a DECISION column moved (the breaker state or the outage it belongs to): the heartbeat itself is a fact, not a
-- business change, while every open / half_open / closed transition is audited.
CREATE TRIGGER "external_feed_listener_state_audit_ins" AFTER INSERT ON external_feed_listener_state
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "external_feed_listener_state_audit_upd" AFTER UPDATE ON external_feed_listener_state
  FOR EACH ROW
  WHEN (OLD.circuit_state IS DISTINCT FROM NEW.circuit_state
        OR OLD.outage_opened_at IS DISTINCT FROM NEW.outage_opened_at)
  EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "external_feed_listener_state_audit_del" AFTER DELETE ON external_feed_listener_state
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
