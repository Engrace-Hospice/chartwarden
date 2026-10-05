-- M2 invitation accept: the pre-org token lookup, moved onto a narrow SECURITY DEFINER read.
--
-- `POST /api/v1/invitations/accept` (and the pre-auth invite preview) find an invitation by the hash of
-- the one-time token. The caller has no organization bound yet (they are the just-signed-up invitee), and
-- `organization_invitation` is RLS-scoped on app.org_id, so the bare `select ... where token_hash = $1`
-- failed for the real NOBYPASSRLS `wardenx_app` role (the policy's `::uuid` cast of the unset GUC → 500).
-- Every accept was broken against a real deployment; the in-process suites connected as a superuser.
--
-- Same least-privilege shape as 0231's `m2_list_own_memberships`:
--   * `invitation_token_reader` — a NOLOGIN role wardenx_app does NOT inherit. SELECT on exactly the
--     columns the accept flow reads plus a SELECT-only policy on the two tables (FORCE RLS applies to it).
--   * `m2_find_invitation_by_token(p_token_hash)` — owned by that role, pinned search_path, EXECUTE only
--     for wardenx_app. It returns the ONE invitation whose token hash was passed in. The hash is a sha256
--     of a 128-bit random token, so possession of it is the capability; the function cannot enumerate rows.
-- The status flip (the atomic one-time claim) is NOT done here: the store runs it afterwards under the
-- invitation's own org context, through the ordinary tenant policy.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invitation_token_reader') THEN
    CREATE ROLE invitation_token_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO invitation_token_reader;--> statement-breakpoint
GRANT invitation_token_reader TO wardenx_admin;--> statement-breakpoint
COMMENT ON ROLE invitation_token_reader IS
  'Owns m2_find_invitation_by_token (SECURITY DEFINER): the pre-org invitation lookup by token hash. wardenx_app does NOT inherit this role; it reaches these rows only through that function.';--> statement-breakpoint

GRANT SELECT ("id", "organization_id", "email", "status", "proposed_role_keys",
              "proposed_default_location_ids", "inviter_id", "expires_at", "token_hash")
  ON "organization_invitation" TO invitation_token_reader;--> statement-breakpoint
GRANT SELECT ("id", "display_name") ON "organization" TO invitation_token_reader;--> statement-breakpoint

CREATE POLICY "organization_invitation_token_reader_read" ON "organization_invitation"
  FOR SELECT TO invitation_token_reader
  USING (true);--> statement-breakpoint
CREATE POLICY "organization_invitation_token_reader_org_read" ON "organization"
  FOR SELECT TO invitation_token_reader
  USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m2_find_invitation_by_token(p_token_hash text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  organization_name text,
  email text,
  status text,
  proposed_role_keys jsonb,
  proposed_default_location_ids jsonb,
  inviter_id uuid,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.organization_id, o.display_name, i.email, i.status::text, i.proposed_role_keys,
         i.proposed_default_location_ids, i.inviter_id, i.expires_at
  FROM organization_invitation i
  JOIN organization o ON o.id = i.organization_id
  WHERE p_token_hash IS NOT NULL
    AND i.token_hash = p_token_hash
  LIMIT 1
$$;--> statement-breakpoint
ALTER FUNCTION m2_find_invitation_by_token(text) OWNER TO invitation_token_reader;--> statement-breakpoint
REVOKE ALL ON FUNCTION m2_find_invitation_by_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m2_find_invitation_by_token(text) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION m2_find_invitation_by_token(text) IS
  'SECURITY DEFINER (owner invitation_token_reader): the one invitation matching a token hash, for the pre-org accept flow. The status flip runs afterwards under the invitation''s own org context.';
