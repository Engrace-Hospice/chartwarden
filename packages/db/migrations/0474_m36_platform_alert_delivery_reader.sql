-- 0474 — M36 GAP-165: the platform-ops cross-tenant delivery reader behind
-- `GET /api/v1/admin/messaging/alert-deliveries` (spec §4.1, `messaging.admin.read`).
--
-- `notification_delivery` is a parent-join child of `alert`, and both are tenant-RLS'd on `app.org_id`, so the
-- tenant app pool can never see another org's rows — which is exactly right, and exactly why a platform-ops
-- "which deliveries are failing across the fleet" view cannot be a plain query. It is a SECURITY DEFINER function,
-- owned by a dedicated NOLOGIN role that holds SELECT-only on these two tables and a SELECT-only `USING (true)`
-- policy on each (the 0202 `mdm_canonical_writer` shape). The function is the ONLY door:
--   • it returns DELIVERY METADATA ONLY — ids, org, category/severity, channel, status, a truncated failure reason,
--     timestamps. No recipient identity, no destination (phone/email/push endpoint), no message or alert payload;
--   • it is bounded (`p_limit` clamped 1..200) and keyset-paginated (`p_before`), so it cannot be used to dump;
--   • it never writes.
-- The route that calls it is platform-ops-only (an ABAC conjunct, not just the RBAC key) and writes an org-less
-- platform audit event per read, so every cross-tenant look is on the trail.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'messaging_admin_reader') THEN
    CREATE ROLE messaging_admin_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO messaging_admin_reader;--> statement-breakpoint
COMMENT ON ROLE messaging_admin_reader IS
  'Owns the platform-ops cross-tenant notification_delivery READER function (M36 GAP-165). SELECT only; reachable solely through messaging_admin_list_alert_deliveries().';--> statement-breakpoint
GRANT SELECT ON "alert" TO messaging_admin_reader;--> statement-breakpoint
GRANT SELECT ON "notification_delivery" TO messaging_admin_reader;--> statement-breakpoint
DROP POLICY IF EXISTS "alert_admin_reader" ON "alert";--> statement-breakpoint
CREATE POLICY "alert_admin_reader" ON "alert"
  FOR SELECT TO messaging_admin_reader USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS "notification_delivery_admin_reader" ON "notification_delivery";--> statement-breakpoint
CREATE POLICY "notification_delivery_admin_reader" ON "notification_delivery"
  FOR SELECT TO messaging_admin_reader USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION messaging_admin_list_alert_deliveries(
  p_status text DEFAULT 'failed',
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
) RETURNS TABLE (
  delivery_id uuid,
  organization_id uuid,
  alert_id uuid,
  alert_category text,
  alert_severity text,
  channel text,
  status text,
  fail_reason text,
  queued_at timestamptz,
  sent_at timestamptz,
  settled_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, a.organization_id, d.alert_id, d.alert_category::text, d.alert_severity::text,
         d.channel::text, d.status::text, left(d.fail_reason, 200), d.queued_at, d.sent_at, d.settled_at
  FROM notification_delivery d
  JOIN alert a ON a.id = d.alert_id
  WHERE (p_status = 'all' OR d.status::text = p_status)
    AND (p_before IS NULL OR d.queued_at < p_before)
  ORDER BY d.queued_at DESC, d.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;--> statement-breakpoint
ALTER FUNCTION messaging_admin_list_alert_deliveries(text, integer, timestamptz) OWNER TO messaging_admin_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION messaging_admin_list_alert_deliveries(text, integer, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION messaging_admin_list_alert_deliveries(text, integer, timestamptz) TO wardenx_app;
