-- GAP-101 — M36 out-of-band delivery workers + vendor webhooks (spec §2.4.4, §4.4, §4.9).
--
-- The push/SMS/voice/email dispatcher is a DB-driven sweep over `notification_delivery` (a row is its own
-- queue entry), so the row needs the three bookkeeping columns a queue would otherwise hold:
--   attempt_count   — how many times a dispatcher CLAIMED the row (retry budget = the §4.4.1 `attempts`)
--   next_attempt_at — earliest instant the next attempt may run (the §4.4.1 backoff, persisted)
--   claimed_until   — a LEASE: a claimed row is invisible to other sweeps until it expires, so two
--                     instances never send the same delivery, and a crash mid-send re-opens the row
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "claimed_until" timestamp with time zone;--> statement-breakpoint

-- The sweep's hot predicate: pending out-of-band rows, oldest first.
CREATE INDEX IF NOT EXISTS "notification_delivery_dispatch_idx"
  ON "notification_delivery" ("queued_at")
  WHERE "status" = 'pending' AND "channel" <> 'in_app';--> statement-breakpoint

-- ── Two narrow SECURITY DEFINER readers/writers (the 0193/0194 pattern) ─────────────────────────────────
-- `delivery_endpoint` is USER-owned (RLS on app.user_id, migration 0017), and the Twilio/Postmark callbacks
-- carry NO tenant context, so neither the dispatcher nor the webhook can reach what it needs as a plain
-- `wardenx_app` org session. Each function below is owned by `wardenx_admin`, EXECUTE-granted to
-- `wardenx_app`, and is scoped by an argument the caller cannot widen: the endpoint functions take the
-- tenant AND a delivery id and only ever resolve the endpoint of THAT delivery's recipient (verified through
-- the delivery's own alert's organization_id); the vendor locator returns ids only (no endpoint value, no
-- body, no recipient). The function owner needs the table GRANT as well as the policy (0193's note).
CREATE POLICY notification_delivery_admin_read ON notification_delivery
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint
GRANT SELECT ON notification_delivery TO wardenx_admin;--> statement-breakpoint
CREATE POLICY alert_admin_read ON alert
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint
GRANT SELECT ON alert TO wardenx_admin;--> statement-breakpoint
CREATE POLICY delivery_endpoint_admin_rw ON delivery_endpoint
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, UPDATE ON delivery_endpoint TO wardenx_admin;--> statement-breakpoint

-- 1. The vendor callback → delivery locator. A vendor message id (Twilio SID / Postmark MessageID) is the
--    ONLY key a webhook has. Returns the owning delivery + tenant so the caller can open an org-scoped
--    transaction and do everything else under ordinary RLS. Zero rows when unknown; the caller treats that
--    as "not ours" (a callback for a send this deployment never made).
CREATE OR REPLACE FUNCTION notification_delivery_locate_by_vendor(
  p_channel notification_channel,
  p_vendor_message_id text
) RETURNS TABLE (delivery_id uuid, organization_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT nd.id, a.organization_id
  FROM notification_delivery nd
  JOIN alert a ON a.id = nd.alert_id
  WHERE nd.vendor_message_id = p_vendor_message_id
    AND nd.channel = p_channel;
$$;--> statement-breakpoint
ALTER FUNCTION notification_delivery_locate_by_vendor(notification_channel, text) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION notification_delivery_locate_by_vendor(notification_channel, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notification_delivery_locate_by_vendor(notification_channel, text) TO wardenx_app;--> statement-breakpoint

-- 2. The destination the dispatcher sends to: the newest VERIFIED endpoint of the delivery's recipient on the
--    delivery's channel (voice reuses the sms endpoint, §3.5). Zero rows = the recipient has no usable
--    endpoint, which the dispatcher settles as a failure rather than guessing a number.
CREATE OR REPLACE FUNCTION delivery_endpoint_for_delivery(
  p_organization_id uuid,
  p_delivery_id uuid
) RETURNS TABLE (endpoint_id uuid, endpoint_value text, consecutive_failures integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.endpoint_value, e.consecutive_failures
  FROM notification_delivery nd
  JOIN alert a ON a.id = nd.alert_id AND a.organization_id = p_organization_id
  JOIN delivery_endpoint e
    ON e.user_id = nd.recipient_user_id
   AND e.verification_status = 'verified'
   AND e.channel::text = CASE nd.channel::text WHEN 'voice' THEN 'sms' ELSE nd.channel::text END
  WHERE nd.id = p_delivery_id
  ORDER BY e.created_at DESC
  LIMIT 1;
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_for_delivery(uuid, uuid) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) TO wardenx_app;--> statement-breakpoint

-- 3. Endpoint health bookkeeping (§3.5 `consecutive_failures` / `last_failure_at`): a success clears the run,
--    a failure extends it. Touches only the endpoint recorded on THAT delivery, inside the tenant that owns it.
CREATE OR REPLACE FUNCTION delivery_endpoint_record_result(
  p_organization_id uuid,
  p_delivery_id uuid,
  p_success boolean
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE delivery_endpoint e
     SET consecutive_failures = CASE WHEN p_success THEN 0 ELSE e.consecutive_failures + 1 END,
         last_failure_at = CASE WHEN p_success THEN e.last_failure_at ELSE now() END
    FROM notification_delivery nd
    JOIN alert a ON a.id = nd.alert_id AND a.organization_id = p_organization_id
   WHERE nd.id = p_delivery_id
     AND e.id = nd.endpoint_id;
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_record_result(uuid, uuid, boolean) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_record_result(uuid, uuid, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_record_result(uuid, uuid, boolean) TO wardenx_app;
