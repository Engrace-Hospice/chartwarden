-- 0740 — M34 GAP-057: make M34's two recipient resolvers (spec module-34 §4.8) bindable.
--
-- 1. `alert_recipient_resolver` is a pgEnum that carried only M36's seven built-ins, so an `alert_rule` row
--    naming `compliance_officer_for_tenant` / `platform_security_owner` could not even be INSERTed through
--    `alert_rule_platform_upsert`. Both values are appended (their own statements: a new enum value is not
--    usable until committed, and nothing here uses them).
-- 2. `platform_security_owner` is a PLATFORM-scoped audience: the holders are users bound to the
--    platform-OWNED role row (`role.organization_id IS NULL`, key `platform_security_owner`) in whatever org
--    they hold a membership in — never the emit-org of a tenant-lifecycle alert. `membership` /
--    `membership_role` are tenant-RLS'd, so the tenant app pool cannot read that set; a SECURITY DEFINER
--    function owned by a dedicated NOLOGIN role (SELECT only, `USING (true)` policies for that role alone —
--    the 0474 `messaging_admin_reader` shape) is the only door. It returns USER IDS ONLY (no PII), only for
--    platform-owned roles, only ACTIVE memberships with a live grant, and it never writes.
ALTER TYPE "public"."alert_recipient_resolver" ADD VALUE IF NOT EXISTS 'compliance_officer_for_tenant';--> statement-breakpoint
ALTER TYPE "public"."alert_recipient_resolver" ADD VALUE IF NOT EXISTS 'platform_security_owner';--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'm34_platform_role_reader') THEN
    CREATE ROLE m34_platform_role_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO m34_platform_role_reader;--> statement-breakpoint
COMMENT ON ROLE m34_platform_role_reader IS
  'Owns the M34 platform-role-holder READER function (GAP-057). SELECT only; reachable solely through m34_platform_role_holders().';--> statement-breakpoint
GRANT SELECT ON "membership" TO m34_platform_role_reader;--> statement-breakpoint
GRANT SELECT ON "membership_role" TO m34_platform_role_reader;--> statement-breakpoint
GRANT SELECT ON "role" TO m34_platform_role_reader;--> statement-breakpoint
DROP POLICY IF EXISTS "membership_m34_platform_role_reader" ON "membership";--> statement-breakpoint
CREATE POLICY "membership_m34_platform_role_reader" ON "membership"
  FOR SELECT TO m34_platform_role_reader USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS "membership_role_m34_platform_role_reader" ON "membership_role";--> statement-breakpoint
CREATE POLICY "membership_role_m34_platform_role_reader" ON "membership_role"
  FOR SELECT TO m34_platform_role_reader USING (true);--> statement-breakpoint
DROP POLICY IF EXISTS "role_m34_platform_role_reader" ON "role";--> statement-breakpoint
CREATE POLICY "role_m34_platform_role_reader" ON "role"
  FOR SELECT TO m34_platform_role_reader USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_platform_role_holders(p_role_keys text[])
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT m.user_id
  FROM membership_role mr
  JOIN role r ON r.id = mr.role_id
  JOIN membership m ON m.id = mr.membership_id
  WHERE r.organization_id IS NULL
    AND r.enabled
    AND r.key = ANY (p_role_keys)
    AND r.key LIKE 'platform\_%'
    AND m.status = 'active'
    AND (mr.expires_at IS NULL OR mr.expires_at > now());
$$;--> statement-breakpoint
ALTER FUNCTION m34_platform_role_holders(text[]) OWNER TO m34_platform_role_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_platform_role_holders(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_platform_role_holders(text[]) TO wardenx_app;
