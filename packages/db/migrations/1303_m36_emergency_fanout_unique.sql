-- compat: contract
-- ADR-0106 review follow-up (PR #937): make the emergency multi-device fan-out idempotent in the DATABASE, not only in the
-- NOT EXISTS of delivery_endpoint_fan_out (1301). Two resolveDestination runs for the same unbound critical push delivery can overlap
-- under READ COMMITTED (a slow resolve outlives its lease and claimBatch re-claims the row); neither sees the other's uncommitted
-- siblings, so each inserted a sibling per other device and every phone got the emergency push twice.
--
-- One delivery per (alert, recipient, device) for a CRITICAL PUSH. The index is partial on exactly the rows fan-out writes and binds:
-- non-critical and non-push deliveries may legitimately rebind to a newer endpoint on retry and are not constrained. The dispatcher's
-- sibling INSERT now carries ON CONFLICT DO NOTHING, so the loser of the race inserts nothing instead of failing.
--
-- Declared `contract`: a unique index can reject writes an earlier release made. It builds only if no (alert, recipient, endpoint)
-- critical push pair is already duplicated; fan-out shipped with ADR-0106 step A1/#937 and has not produced such rows.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_delivery_critical_push_endpoint_uq"
  ON "notification_delivery" ("alert_id", "recipient_user_id", "endpoint_id")
  WHERE "endpoint_id" IS NOT NULL
    AND "channel" = 'push'
    AND "alert_severity" = 'critical';
