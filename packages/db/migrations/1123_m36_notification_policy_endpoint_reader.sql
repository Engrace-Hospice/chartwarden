-- M36 WP 4.6 (ADR-0073) - the notification policy plans an out-of-band route ONLY for a recipient who has a VERIFIED endpoint on
-- that channel, so at plan time (before any delivery row exists) it must ask "on which channels does each of these users have a
-- verified endpoint?". `delivery_endpoint` is USER-owned (RLS on app.user_id, 0017) and the planner runs in a worker/outbox consumer
-- with no acting user, so it can only reach the answer through a SECURITY DEFINER reader (the 0193 / 0194 / 0355 pattern).
--
-- Scope the caller cannot widen: the tenant argument must EQUAL the session tenant (`app.org_id`, set by withOrgContext; a call with
-- another tenant's id or with no tenant context returns nothing), and a user is returned ONLY if they hold an ACTIVE membership in
-- THAT tenant. The id list must be a JSON array of at most 500 ids (anything else raises), so the function cannot be used to sweep. It returns (user_id, channel) and
-- NEVER the endpoint value (no phone number, address or push subscription leaves the table through this function). Voice rides on
-- the sms endpoint (§3.5), so it is not listed separately. `membership` is readable by the function owner through 0215's policy.
CREATE OR REPLACE FUNCTION delivery_endpoint_verified_channels_for_org_users(
  p_organization_id uuid,
  p_user_ids jsonb
) RETURNS TABLE (user_id uuid, channel text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(p_user_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_user_ids) > 500 THEN
    RAISE EXCEPTION 'p_user_ids must be a JSON array of at most 500 ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.user_id, e.channel::text
  FROM delivery_endpoint e
  JOIN membership m
    ON m.user_id = e.user_id
   AND m.organization_id = p_organization_id
   AND m.status = 'active'
  WHERE e.verification_status = 'verified'
    AND p_organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND e.user_id IN (SELECT (jsonb_array_elements_text(p_user_ids))::uuid);
END;
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_verified_channels_for_org_users(uuid, jsonb) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_verified_channels_for_org_users(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_verified_channels_for_org_users(uuid, jsonb) TO wardenx_app;
