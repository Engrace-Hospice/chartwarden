-- M2 pre-organization membership picker, moved off user-keyed RLS (supersedes 0213 + 0214).
--
-- 0213/0214 let `wardenx_app` read `membership` / `organization` rows keyed on the
-- app.user_id session setting so `GET /api/v1/auth/memberships` could list a user's memberships
-- before any org is bound. That made app.user_id an RLS visibility variable, which ADR-0010 D2
-- forbids: row visibility keys ONLY on app.org_id. This migration drops both policies and replaces
-- them with one narrow SECURITY DEFINER read, the same least-privilege shape as M34's key-ring
-- functions (0050/0055) and M4's audit writer:
--
--   * `membership_picker_reader` — a NOLOGIN role that wardenx_app does NOT inherit. It holds
--     SELECT on exactly the columns the picker needs and a SELECT-only policy on the two tables
--     (FORCE RLS since 0118 applies to it too, so it needs a policy of its own).
--   * `m2_list_own_memberships(p_user_id)` — owned by that role, pinned search_path, EXECUTE granted
--     only to wardenx_app. It returns the memberships of the ONE user passed in and their org
--     display names; it cannot enumerate other users or return any other column.
--
-- The caller passes the authenticated session's user id (membership-repository.ts `listForUser`),
-- the same trust wardenx_app already had when it set app.user_id itself.

DROP POLICY IF EXISTS "membership_self_pre_org_read" ON "membership";--> statement-breakpoint
DROP POLICY IF EXISTS "organization_member_pre_org_read" ON "organization";--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'membership_picker_reader') THEN
    CREATE ROLE membership_picker_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO membership_picker_reader;--> statement-breakpoint
GRANT membership_picker_reader TO wardenx_admin;--> statement-breakpoint
COMMENT ON ROLE membership_picker_reader IS
  'Owns m2_list_own_memberships (SECURITY DEFINER): the pre-org membership picker read. wardenx_app does NOT inherit this role; it reaches these rows only through that function (supersedes the 0213/0214 user-keyed policies, ADR-0010 D2).';--> statement-breakpoint

GRANT SELECT ("id", "user_id", "organization_id", "status", "default_location_ids")
  ON "membership" TO membership_picker_reader;--> statement-breakpoint
GRANT SELECT ("id", "display_name") ON "organization" TO membership_picker_reader;--> statement-breakpoint

-- SELECT-only and scoped to the definer role: no wardenx_app policy is added or widened here.
CREATE POLICY "membership_picker_reader_read" ON "membership"
  FOR SELECT TO membership_picker_reader
  USING (true);--> statement-breakpoint
CREATE POLICY "organization_picker_reader_read" ON "organization"
  FOR SELECT TO membership_picker_reader
  USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m2_list_own_memberships(p_user_id uuid)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  organization_id uuid,
  organization_name text,
  status text,
  default_location_ids jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.id, m.user_id, m.organization_id, o.display_name, m.status::text, m.default_location_ids
  FROM membership m
  JOIN organization o ON o.id = m.organization_id
  WHERE p_user_id IS NOT NULL
    AND m.user_id = p_user_id
$$;--> statement-breakpoint
ALTER FUNCTION m2_list_own_memberships(uuid) OWNER TO membership_picker_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION m2_list_own_memberships(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m2_list_own_memberships(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION m2_list_own_memberships(uuid) IS
  'SECURITY DEFINER (owner membership_picker_reader): one user''s memberships + org display names for the pre-org picker (GET /api/v1/auth/memberships). Replaces the 0213/0214 app.user_id RLS policies (ADR-0010 D2).';
