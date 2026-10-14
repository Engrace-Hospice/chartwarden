-- 1097 — M34: a ZERO-PERMISSION platform-owned role for tenant alert delivery, and a safer holder reader.
--
-- WHY. bind-platform-staff.ts used to bind each platform-ops operator into every new tenant with the
-- platform-owned `platform_ops` role so M36's `role_set` resolver (a membership_role -> role join INSIDE the
-- tenant org) had a recipient. But `platform_ops` carries `user.password.reset` / `user.deactivate`, and the
-- tenant routes gate on requirePermission() alone, so a bound operator could reset any tenant user's password.
-- The tenant binding now uses `platform_alert_audience`: platform-owned (organization_id IS NULL, 0318/0320),
-- reserved by the `platform_` prefix, and given exactly ONE permission, `alert.inbox.self`: it gates only
-- GET /alerts/inbox and POST /alerts/:id/read, both of which are scoped to the caller's own alert recipient rows,
-- so the operator can read the alerts addressed to them and nothing else (no messaging, no PHI, no user admin).
-- It is deliberately NOT in PLATFORM_OPS_ROLE_KEYS / the template catalog: nothing else may grant it any authority.
--
-- Platform roles are otherwise created lazily by scripts/db/platform-role.ts; this one is a migration because
-- the tenant-provision hook (not an operator) needs it to exist.
INSERT INTO "role" ("organization_id", "key", "name", "category", "scope_level", "system_default", "system_locked", "enabled", "description")
VALUES (NULL, 'platform_alert_audience', 'Platform Alert Audience', 'platform_staff', 'organization', false, false, true,
        'Bound to platform operators in a tenant org so role_set alerts reach them. Holds one self-only permission (alert.inbox.self): their own alert inbox.')
ON CONFLICT ("key") WHERE "organization_id" IS NULL DO NOTHING;--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('alert.inbox.self', 'alert_inbox', 'self', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'alert.inbox.self'
  FROM "role" r
 WHERE r."key" = 'platform_alert_audience' AND r."organization_id" IS NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

-- m34_platform_role_holders now (a) skips globally deactivated users and (b) exposes the grant's expiry so a
-- derived binding can be time-bound the same way. The return type changes, so drop and recreate; the only
-- callers select `user_id` by name. A user with several grants is time-bound only if EVERY grant is
-- (NULL expires_at = a permanent grant wins).
DROP FUNCTION IF EXISTS m34_platform_role_holders(text[]);--> statement-breakpoint
GRANT SELECT ("id", "status") ON "user" TO m34_platform_role_reader;--> statement-breakpoint
CREATE FUNCTION m34_platform_role_holders(p_role_keys text[])
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
    AND r.key LIKE 'platform\_%'
    AND r.key <> 'platform_alert_audience' -- the derived tenant binding is never itself a source of operators
    AND m.status = 'active'
    AND u.status <> 'deactivated'
    AND (mr.expires_at IS NULL OR mr.expires_at > now())
  GROUP BY m.user_id;
$$;--> statement-breakpoint
ALTER FUNCTION m34_platform_role_holders(text[]) OWNER TO m34_platform_role_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_platform_role_holders(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_platform_role_holders(text[]) TO wardenx_app;
