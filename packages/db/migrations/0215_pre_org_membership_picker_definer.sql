-- F-001 (#15) — the pre-organization membership picker, rebuilt on the SECURITY DEFINER pattern.
--
-- WHAT WAS WRONG. Migrations 0213/0214 served the post-sign-in org picker by adding two PERMISSIVE
-- policies for `wardenx_app` keyed on `app.user_id`: `membership_self_pre_org_read` on `membership`
-- and `organization_member_pre_org_read` on `organization`. 0213's header asserts the request "never
-- gains a cross-tenant or arbitrary-org context". That is true of the CALL SITE and false of the
-- POLICY. A policy is scoped to a ROLE and a COMMAND, not to a call site, and PostgreSQL takes the
-- UNION of every permissive policy that matches — so a narrow extra policy WIDENS access rather than
-- carving out an exception. `withOrgContext()` (packages/tenancy/src/context.ts) sets `app.user_id`
-- on EVERY ordinary request for M4 audit attribution, so the pre-org policy was live on all of them,
-- and on each one it admitted the caller's membership rows in EVERY organization regardless of
-- `app.org_id` — plus, through the EXISTS sub-select, those organizations' rows themselves.
--
-- Reproduced against a real NOBYPASSRLS Postgres: an org-B-scoped session read the caller's org-A
-- membership row and org A's `organization` row (see the F-001 block in
-- packages/db/migrations/__tests__/m1-rls-isolation.live.test.ts).
--
-- WHY THIS SHAPE. ADR-0010 D2 makes `app.org_id` the ONLY RLS session variable, and D3 bans exactly
-- the "second permissive policy branch that ORs together" shape 0213 introduced. The codebase already
-- has the compliant answer for "a legitimate read that the tenant policy cannot express": a
-- SECURITY DEFINER function owned by a DIFFERENT role that may see the rows, EXECUTE-granted to
-- `wardenx_app` — migrations 0187, 0189, 0193 and 0194 all use it, and 0194 solves the structurally
-- identical M36 problem. Dropping the policies rather than narrowing them means there is no second
-- permissive branch left to union with, so the widening cannot recur by accident.
--
-- SCOPE OF THE DEFINER. `p_user_id` is the function's only parameter and its only scope. That matches
-- 0194's `user_notification_preferences_for_org_users(p_organization_id, p_user_ids)` precedent: the
-- `wardenx_app` connection is backend-only — no end user authors SQL against it — and the caller
-- passes the id better-auth just authenticated, exactly as it previously passed that same id into
-- `set_config('app.user_id', ...)`. The function is EXECUTE-revoked from PUBLIC and returns only
-- membership rows for that one user, so it can never be widened into a cross-user or cross-org scan.
-- It reads no PHI: membership status, the org display name, and the user's own account fields.

DROP POLICY IF EXISTS "membership_self_pre_org_read" ON "membership";--> statement-breakpoint
DROP POLICY IF EXISTS "organization_member_pre_org_read" ON "organization";--> statement-breakpoint

-- Per migration 0193's note, SECURITY DEFINER changes which role's ROW-level policies apply but does
-- NOT confer table privileges: the owner needs both a policy and the table GRANT. `membership` and
-- `organization` are ENABLE+FORCE RLS (0118), so wardenx_admin needs a policy on each; `user` and
-- `session` are deliberately un-RLS'd (0001), so a GRANT alone is enough. All SELECT-only — this
-- function never writes.
CREATE POLICY "membership_admin_read" ON "membership"
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint
CREATE POLICY "organization_admin_read" ON "organization"
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint
GRANT SELECT ON "membership" TO wardenx_admin;--> statement-breakpoint
GRANT SELECT ON "organization" TO wardenx_admin;--> statement-breakpoint
GRANT SELECT ON "user" TO wardenx_admin;--> statement-breakpoint
GRANT SELECT ON "session" TO wardenx_admin;--> statement-breakpoint

-- The picker projection is the same one the repository's Drizzle join built (MEMBERSHIP_COLUMNS in
-- apps/backend/src/modules/02-identity/membership-repository.ts), so the call site's row shape is
-- unchanged.
CREATE OR REPLACE FUNCTION membership_pre_org_picker(p_user_id uuid)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  organization_id uuid,
  organization_name text,
  status membership_status,
  default_location_ids jsonb,
  display_name text,
  email text,
  account_status user_status,
  last_login_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    m.id,
    m.user_id,
    m.organization_id,
    o.display_name,
    m.status,
    m.default_location_ids,
    u.name,
    u.email,
    u.status,
    (SELECT max(s.created_at) FROM "session" s WHERE s.user_id = m.user_id)
  FROM "membership" m
  JOIN "organization" o ON o.id = m.organization_id
  JOIN "user" u ON u.id = m.user_id
  WHERE m.user_id = p_user_id;
$$;--> statement-breakpoint
ALTER FUNCTION membership_pre_org_picker(uuid) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION membership_pre_org_picker(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION membership_pre_org_picker(uuid) TO wardenx_app;--> statement-breakpoint

-- Independently of the picker: `SET LOCAL`/`set_config(..., true)` reverts a custom GUC to the EMPTY
-- STRING at commit, not to NULL (verified: `current_setting('app.org_id', true)` returns '' on a
-- pooled connection that previously served an org-scoped transaction). `''::uuid` raises 22P02, so
-- these two policies could abort a statement rather than simply deny it. Migration 0214 fixed exactly
-- this for `app.user_id`; the org side was left unguarded. NULLIF turns '' into NULL, which makes the
-- comparison NULL — no rows — so the behaviour stays fail-CLOSED and only the error goes away.
DROP POLICY IF EXISTS "membership_org" ON "membership";--> statement-breakpoint
CREATE POLICY "membership_org" ON "membership"
  FOR ALL TO wardenx_app
  USING ("organization_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "organization_self" ON "organization";--> statement-breakpoint
CREATE POLICY "organization_self" ON "organization"
  FOR ALL TO wardenx_app
  USING ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
