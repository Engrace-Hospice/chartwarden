-- WP 5.11 / W6: native push. A push endpoint is no longer always a browser Web Push subscription.
--
--   delivery_endpoint.provider: 'web' (VAPID subscription JSON, the only value until now), 'fcm' (Android token via FCM v1) or
--   'apns' (iOS device token via APNs). Existing rows are 'web' by the column default. A native provider is only meaningful on the
--   push channel, so a CHECK pins that; sms/email stay 'web' (the column default) and are never read by provider.
--
--   delivery_endpoint stays user-owned (RLS delivery_endpoint_self on app.user_id) and keeps its (user_id, channel, endpoint_value)
--   unique index: an FCM/APNs token and a Web Push subscription JSON can never be the same string, so the provider does not need to
--   join the key.
--
--   delivery_endpoint_for_delivery (0355) now also returns the provider (so the dispatcher can route one push channel to the right
--   transport) and the delivery's own alert id (the opaque, PHI-free hint a native push carries; the app re-fetches it authenticated). A function whose result row changes cannot be CREATE OR REPLACEd, so it is dropped and recreated with the same
--   owner, search_path, scoping and grants.
CREATE TYPE "public"."delivery_endpoint_provider" AS ENUM ('web', 'fcm', 'apns');--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD COLUMN "provider" "delivery_endpoint_provider" NOT NULL DEFAULT 'web';--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD CONSTRAINT "delivery_endpoint_provider_push_only_chk" CHECK ("provider" = 'web' OR "channel" = 'push');--> statement-breakpoint

DROP FUNCTION delivery_endpoint_for_delivery(uuid, uuid);--> statement-breakpoint
CREATE FUNCTION delivery_endpoint_for_delivery(
  p_organization_id uuid,
  p_delivery_id uuid
) RETURNS TABLE (endpoint_id uuid, endpoint_value text, consecutive_failures integer, provider delivery_endpoint_provider, alert_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.endpoint_value, e.consecutive_failures, e.provider, a.id
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
ALTER FUNCTION delivery_endpoint_for_delivery(uuid, uuid) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) TO chartwarden_app;
