-- M31 portal invitee SIGN-IN — the pre-org portal-account read (GAP-092 follow-up).
--
-- A portal invitee authenticates through Better Auth (magic link / password + TOTP / passkey), which yields a
-- PRE-ORG session: the `session` row carries a user but no `active_organization_id`. To bind that session to a
-- portal account the server must first learn WHICH portal accounts (in which tenants) the signed-in user holds —
-- and `portal_account` / `portal_access_grant` are RLS-scoped on app.org_id, with no org bound yet. The
-- same chicken-and-egg 0231 solved for the staff membership picker, solved the same way and not by making
-- `app.user_id` a visibility variable (ADR-0010 D2 forbids it):
--
--   * `portal_signin_reader` — a NOLOGIN role wardenx_app does NOT inherit. SELECT on exactly the columns the
--     sign-in decision reads, and a SELECT-only policy on the three RLS tables (FORCE RLS applies to it too).
--   * `m31_list_own_portal_accounts(p_user_id)` — owned by that role, pinned search_path, EXECUTE only for
--     wardenx_app. It returns the portal accounts of the ONE user passed in (the caller passes the authenticated
--     session's user id, never a request field), the tenant's display name and lifecycle status, whether the
--     user's email is verified, and the COUNT of live grants and the count of bereaved-mode grants. It returns
--     no contact PHI (the `*_cipher` columns are not granted), no patient id and no grant detail: the patient
--     scope is bound afterwards by `select-patient`, under the tenant's own RLS.
--
-- The write that binds the session (org + session class + scope.portalAccountId) is NOT done here: it is one
-- conditional UPDATE on the `session` row issued by the application (portal-sign-in-store.ts).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_signin_reader') THEN
    CREATE ROLE portal_signin_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO portal_signin_reader;--> statement-breakpoint
GRANT portal_signin_reader TO wardenx_admin;--> statement-breakpoint
COMMENT ON ROLE portal_signin_reader IS
  'Owns m31_list_own_portal_accounts (SECURITY DEFINER): the pre-org portal-account read behind portal sign-in. wardenx_app does NOT inherit this role; it reaches these rows only through that function.';--> statement-breakpoint

GRANT SELECT ("id", "organization_id", "user_id", "relationship", "status", "suspended_at", "revoked_at")
  ON "portal_account" TO portal_signin_reader;--> statement-breakpoint
GRANT SELECT ("portal_account_id", "grant_kind", "revoked_at")
  ON "portal_access_grant" TO portal_signin_reader;--> statement-breakpoint
GRANT SELECT ("id", "display_name", "status") ON "organization" TO portal_signin_reader;--> statement-breakpoint
GRANT SELECT ("id", "email_verified", "status") ON "user" TO portal_signin_reader;--> statement-breakpoint

-- SELECT-only and scoped to the definer role: no wardenx_app policy is added or widened here.
CREATE POLICY "portal_account_signin_reader_read" ON "portal_account"
  FOR SELECT TO portal_signin_reader
  USING (true);--> statement-breakpoint
CREATE POLICY "portal_access_grant_signin_reader_read" ON "portal_access_grant"
  FOR SELECT TO portal_signin_reader
  USING (true);--> statement-breakpoint
CREATE POLICY "organization_portal_signin_reader_read" ON "organization"
  FOR SELECT TO portal_signin_reader
  USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m31_list_own_portal_accounts(p_user_id uuid)
RETURNS TABLE (
  portal_account_id uuid,
  organization_id uuid,
  organization_name text,
  organization_status text,
  relationship text,
  account_status text,
  user_email_verified boolean,
  user_status text,
  live_grant_count integer,
  bereaved_grant_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id,
         a.organization_id,
         o.display_name,
         o.status::text,
         a.relationship::text,
         a.status::text,
         u.email_verified,
         u.status::text,
         (SELECT count(*)::integer FROM portal_access_grant g
           WHERE g.portal_account_id = a.id AND g.revoked_at IS NULL),
         (SELECT count(*)::integer FROM portal_access_grant g
           WHERE g.portal_account_id = a.id AND g.revoked_at IS NULL AND g.grant_kind = 'bereaved_family')
  FROM portal_account a
  JOIN organization o ON o.id = a.organization_id
  JOIN "user" u ON u.id = a.user_id
  WHERE p_user_id IS NOT NULL
    AND a.user_id = p_user_id
    AND a.revoked_at IS NULL
$$;--> statement-breakpoint
ALTER FUNCTION m31_list_own_portal_accounts(uuid) OWNER TO portal_signin_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION m31_list_own_portal_accounts(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m31_list_own_portal_accounts(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION m31_list_own_portal_accounts(uuid) IS
  'SECURITY DEFINER (owner portal_signin_reader): one user''s non-revoked portal accounts + tenant display name + live-grant counts for the pre-org portal sign-in (POST /api/v1/portal/sign-in/establish). No contact PHI, no patient id.';
