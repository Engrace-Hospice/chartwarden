-- GAP-096 — `AlertEmitterPorts.preferencesFor` needs to read MULTIPLE users' notification preferences
-- for one org's fan-out plan, but `user_notification_preferences`'s own RLS (migration 0017,
-- `user_notif_pref_self`) admits only the CALLING session's own row — "the user's own rows only",
-- deliberate: a user's phone number / vacation plan is not every co-worker's business. No per-request
-- `wardenx_app` session can ever read a SECOND user's row this way — confirmed live (every
-- multi-recipient `preferencesFor` call failed with "invalid input syntax for type uuid: ''" before
-- this fix, since the system-actor sentinel `userId: ""` never matches a real row's owner).
--
-- The alert-routing ENGINE (not the requesting individual) legitimately needs this cross-user read —
-- same ADR-0010 D2/D3-compliant SECURITY DEFINER pattern as migration 0193 (a dedicated function owned
-- by a role with its own permissive policy, EXECUTE-granted to wardenx_app, rather than widening the
-- self-only policy itself). `p_user_ids` is a JSON array of uuid strings, not a native uuid[] param —
-- see 0193's header comment on why array-shaped parameters use jsonb here.
-- (see migration 0193's parallel comment: RLS policy alone is not sufficient — the function owner
-- also needs the underlying table-level GRANT, which no prior migration issued to wardenx_admin here.)
CREATE POLICY user_notification_preferences_admin_all ON user_notification_preferences
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON user_notification_preferences TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION user_notification_preferences_for_org_users(
  p_organization_id uuid,
  p_user_ids jsonb
) RETURNS TABLE (
  user_id uuid,
  routing_map jsonb,
  quiet_hours jsonb,
  vacation_forward_to_user_id uuid,
  vacation_until timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT unp.user_id, unp.routing_map, unp.quiet_hours, unp.vacation_forward_to_user_id, unp.vacation_until
  FROM user_notification_preferences unp
  WHERE unp.organization_id = p_organization_id
    AND unp.user_id IN (SELECT (jsonb_array_elements_text(p_user_ids))::uuid);
$$;--> statement-breakpoint
ALTER FUNCTION user_notification_preferences_for_org_users(uuid, jsonb) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION user_notification_preferences_for_org_users(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_notification_preferences_for_org_users(uuid, jsonb) TO wardenx_app;
