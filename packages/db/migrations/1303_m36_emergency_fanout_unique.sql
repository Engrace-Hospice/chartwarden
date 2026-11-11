-- compat: contract
-- ADR-0106 review follow-up (PR #937): make the emergency multi-device fan-out idempotent in the DATABASE, not only in the
-- NOT EXISTS of delivery_endpoint_fan_out (1301). Two resolveDestination runs for the same unbound critical push delivery can overlap
-- under READ COMMITTED (a slow resolve outlives its lease and claimBatch re-claims the row); neither sees the other's uncommitted
-- siblings, so each inserted a sibling per other device and every phone got the emergency push twice.
--
-- One delivery per (alert, recipient, device, forwarding source) for a CRITICAL PUSH. The index is partial on exactly the rows fan-out
-- writes and binds: non-critical and non-push deliveries may legitimately rebind to a newer endpoint on retry and are not constrained.
-- forwarded_from_user_id is part of the key because a vacation-forwarded copy (planBackupDelivery) is a SECOND critical push row for the
-- same (alert, recipient) when the backup is also a direct recipient; both bind to the recipient's newest device, as they did before this
-- index, and must keep doing so (without it the second row's bind would violate the index on every retry). Fan-out siblings carry NULL,
-- which COALESCEs to the nil uuid, so two racing fan-outs of one delivery still collide and the loser's INSERT ... ON CONFLICT adds nothing.
--
-- Declared `contract`: a unique index can reject writes an earlier release made. The preflight below turns a build failure on
-- pre-existing duplicate rows into a clear message (and lists them) instead of an opaque index error that halts the deploy.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1
      FROM notification_delivery
     WHERE endpoint_id IS NOT NULL AND channel = 'push' AND alert_severity = 'critical'
     GROUP BY alert_id, recipient_user_id, endpoint_id,
              COALESCE(forwarded_from_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION '1303: % duplicate critical push delivery group(s) on (alert_id, recipient_user_id, endpoint_id, forwarded_from_user_id) would violate notification_delivery_critical_push_endpoint_uq; resolve them (keep one row per group) and re-run', dup_count;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_delivery_critical_push_endpoint_uq"
  ON "notification_delivery" (
    "alert_id",
    "recipient_user_id",
    "endpoint_id",
    (COALESCE("forwarded_from_user_id", '00000000-0000-0000-0000-000000000000'::uuid))
  )
  WHERE "endpoint_id" IS NOT NULL
    AND "channel" = 'push'
    AND "alert_severity" = 'critical';
