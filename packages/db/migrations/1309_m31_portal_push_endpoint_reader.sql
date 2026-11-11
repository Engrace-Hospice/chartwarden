-- compat: contract
-- (Only a NEW function is created; the gate reads the REVOKE FROM PUBLIC that locks it down as contracting DDL, so this is declared `contract` and a failed deploy halts for an operator.)
-- ADR-0107 D7 - push to the people who can sign a portal request. A portal person holds an ACTIVE `portal_account` and no membership, so
-- 1123's reader (membership-scoped) can never say whether their phone is registered. This is its twin for portal accounts.
--   * `delivery_endpoint` is USER-owned (RLS on app.user_id), and the planner runs in an outbox consumer with no acting user, so the answer
--     can only come from a SECURITY DEFINER reader (the 0193 / 0194 / 0355 / 1123 pattern).
--   * Scope the caller cannot widen: the tenant argument must EQUAL the session tenant (`app.org_id`); a user is returned ONLY with an ACTIVE
--     portal account in THAT tenant; at most 500 ids; it returns (user_id, channel) for VERIFIED PUSH endpoints and never an endpoint value.
CREATE OR REPLACE FUNCTION delivery_endpoint_verified_push_for_portal_users(
  p_organization_id uuid,
  p_user_ids jsonb
) RETURNS TABLE (user_id uuid, channel text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(p_user_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_user_ids) > 500 THEN
    RAISE EXCEPTION 'p_user_ids must be a JSON array of at most 500 ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.user_id, e.channel::text
  FROM public.delivery_endpoint e
  JOIN public.portal_account pa
    ON pa.user_id = e.user_id
   AND pa.organization_id = p_organization_id
   AND pa.status = 'active'
  WHERE e.verification_status = 'verified'
    AND e.channel::text = 'push'
    AND p_organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND e.user_id IN (SELECT (jsonb_array_elements_text(p_user_ids))::uuid);
END;
$$;--> statement-breakpoint
ALTER FUNCTION delivery_endpoint_verified_push_for_portal_users(uuid, jsonb) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION delivery_endpoint_verified_push_for_portal_users(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delivery_endpoint_verified_push_for_portal_users(uuid, jsonb) TO chartwarden_app;
