-- compat: contract
-- ADR-0106 follow-ups: (1) an emergency (critical) push reaches EVERY verified native device of the recipient, (2) APNs host per token.
--
--   delivery_endpoint_for_delivery now also returns the endpoint's `environment` (ADR-0105: 'sandbox' | 'production' | NULL), so the
--   dispatcher can pick the APNs host per token instead of one global setting. It also honours an endpoint the delivery is already BOUND to
--   when that delivery is a critical push: a fan-out sibling must go to its own device, and a retry must not wander to a newer one. Every
--   other delivery keeps "the newest verified endpoint". Ties on created_at break on id so the pick is deterministic.
--
--   delivery_endpoint_fan_out lists the OTHER verified native push endpoints of the recipient that a critical, not-yet-bound push delivery
--   has no delivery for yet. The dispatcher inserts one sibling notification_delivery per id, bound to that endpoint (idempotent per
--   (alert, recipient, channel, endpoint): the NOT EXISTS below), so each device has its own status, retry budget and dead-token handling.
--
--   Both functions keep the owner, search_path, (organization, delivery) scoping and grants of 1153. A function whose result row changes
--   cannot be CREATE OR REPLACEd, so for_delivery is dropped and recreated.
DROP FUNCTION delivery_endpoint_for_delivery(uuid, uuid);--> statement-breakpoint
CREATE FUNCTION delivery_endpoint_for_delivery(
  p_organization_id uuid,
  p_delivery_id uuid
) RETURNS TABLE (endpoint_id uuid, endpoint_value text, consecutive_failures integer, provider delivery_endpoint_provider, alert_id uuid, environment text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id, e.endpoint_value, e.consecutive_failures, e.provider, a.id, e.environment
  FROM notification_delivery nd
  JOIN alert a ON a.id = nd.alert_id AND a.organization_id = p_organization_id
  JOIN delivery_endpoint e
    ON e.user_id = nd.recipient_user_id
   AND e.verification_status = 'verified'
   AND e.channel::text = CASE nd.channel::text WHEN 'voice' THEN 'sms' ELSE nd.channel::text END
   AND (nd.endpoint_id IS NULL
        OR e.id = nd.endpoint_id
        OR NOT (nd.channel::text = 'push' AND nd.alert_severity::text = 'critical'))
  WHERE nd.id = p_delivery_id
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT 1;
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_for_delivery(uuid, uuid) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_for_delivery(uuid, uuid) TO chartwarden_app;--> statement-breakpoint

CREATE FUNCTION delivery_endpoint_fan_out(
  p_organization_id uuid,
  p_delivery_id uuid
) RETURNS TABLE (endpoint_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id
  FROM notification_delivery nd
  JOIN alert a ON a.id = nd.alert_id AND a.organization_id = p_organization_id
  JOIN delivery_endpoint e
    ON e.user_id = nd.recipient_user_id
   AND e.verification_status = 'verified'
   AND e.channel = 'push'
   AND e.provider <> 'web'
  WHERE nd.id = p_delivery_id
    AND nd.channel::text = 'push'
    AND nd.alert_severity::text = 'critical'
    AND nd.endpoint_id IS NULL
    AND e.id <> (SELECT e2.id FROM delivery_endpoint e2
                  WHERE e2.user_id = nd.recipient_user_id AND e2.verification_status = 'verified' AND e2.channel = 'push'
                  ORDER BY e2.created_at DESC, e2.id DESC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM notification_delivery s
                     WHERE s.alert_id = nd.alert_id AND s.recipient_user_id = nd.recipient_user_id
                       AND s.channel = nd.channel AND s.endpoint_id = e.id);
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_fan_out(uuid, uuid) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_fan_out(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_fan_out(uuid, uuid) TO chartwarden_app;
