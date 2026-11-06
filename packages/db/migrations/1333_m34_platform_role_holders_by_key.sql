-- compat: expand
-- M34: m34_platform_role_holders judged "platform staff" by a key PREFIX (`r.key LIKE 'platform\_%'`) on top of the keys the caller
-- named, so a platform-owned authority whose key does not carry the prefix (M32's `ai_safety_owner`, reserved by exact key in
-- packages/auth/src/roles/platform-reserved.ts) was never reported as a holder, and a person holding only that role passed the
-- "platform staff cannot be a tenant's compliance officer or go-live attester" check (migration 1097's reader, M34 wizard).
--
-- The function now relies on what is actually authoritative: the caller's `p_role_keys` and the role being PLATFORM-OWNED
-- (`organization_id IS NULL`; a tenant-owned row with the same key never counts, it is dropped upstream as well, GAP-003). Nothing
-- else changes: same signature and result, the derived `platform_alert_audience` binding is still never a source of operators,
-- only active memberships and non-deactivated users count, grants honour their expiry, and the owner and EXECUTE grants stay
-- as 0740 / 1097 set them (CREATE OR REPLACE keeps them). Callers that pass only `platform_`-prefixed keys (the platform-staff
-- binder, the alert resolvers) see no difference.
CREATE OR REPLACE FUNCTION m34_platform_role_holders(p_role_keys text[])
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.user_id,
         CASE WHEN bool_or(mr.expires_at IS NULL) THEN NULL ELSE max(mr.expires_at) END
  FROM membership_role mr
  JOIN role r ON r.id = mr.role_id
  JOIN membership m ON m.id = mr.membership_id
  JOIN "user" u ON u.id = m.user_id
  WHERE r.organization_id IS NULL
    AND r.enabled
    AND r.key = ANY (p_role_keys)
    AND r.key <> 'platform_alert_audience' -- the derived tenant binding is never itself a source of operators
    AND m.status = 'active'
    AND u.status <> 'deactivated'
    AND (mr.expires_at IS NULL OR mr.expires_at > now())
  GROUP BY m.user_id;
$$;
