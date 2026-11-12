-- compat: contract
-- M34 slice 7 (7S) - the support-session repair, at the database. Four things, found by reading the grants and policies of a freshly
-- migrated database (\dp, pg_policy), not by reading code:
--
--  1. THE LEDGER HAD NOWHERE TO WRITE. support_session_event is LIST-partitioned by organization_id and 0051 created the parent only
--     ("the provision worker makes the per-org children"): no code anywhere creates one, so the first INSERT for any tenant (the
--     `session.start` row of the very first support session) failed with "no partition of relation found for row". A DEFAULT
--     partition takes every organization's rows. Nothing creates per-organization partitions, so nothing is lost to the default; a
--     later per-organization partition would have to move its rows out first, and the tests that create one do so on an empty table.
--  2. THE CARRIER COULD NOT START A SESSION. chartwarden_platform held SELECT and UPDATE on support_session but no INSERT, and no
--     UPDATE on support_consent_grant (an operator's Resolve revokes the grant). It gets INSERT on support_session, and its UPDATE
--     narrows to the two columns a close writes; on the grant, to the three a revoke writes. (The carrier exists only where
--     scripts/db/provision-runtime-roles.ts has run, which re-grants the same on every run; the block below is conditional on it.)
--  3. THE TENANT ROLE COULD REWRITE ANYTHING. chartwarden_app held table-wide UPDATE on support_consent_grant and support_session and
--     INSERT on both ledger and session, under one FOR ALL policy per table: a tenant session could move a grant's expiry, re-open a
--     session or forge a ledger row. What the tenant lane really does is the REVOKE CASCADE (tenant "End help" and grant revoke run in
--     the tenant's own transaction as the app role) and the grant INSERT. So, per table:
--        support_consent_grant   INSERT (an unrevoked grant), UPDATE of the three revoke columns only, an unrevoked grant only, to a
--                                revoked state with a reason
--        support_session         no INSERT (the platform carrier starts sessions); UPDATE of closed_at and close_reason only, an OPEN
--                                session only, to a closed one with close_reason = 'grant_revoked' (the cascade's value)
--        support_session_event   INSERT only a `session.close` row with no patient (the cascade's ledger row); the platform carrier
--                                writes every other kind (it is BYPASSRLS), so an `ops.write` row can never be forged from the tenant
--     SELECT stays org-scoped on all three (the tenant reads its own sessions and ledger).
--     Nothing the previous release does is narrowed away: it only ever updated those columns and inserted grants. The header is still
--     `contract`, not `expand`: this file DROPs the permissive FOR ALL policies and REVOKEs privileges, which is what the gate
--     (check-migration-compat) calls contracting, and a repeated revoke now matches no row instead of overwriting the first (the
--     cascade reads the grant first, so the new code never does it). Declare contract when unsure.
--  4. THE ROLES HAD NO KEYS. support_session.list_platform / start / close were never granted to the platform_ops role (the routes
--     refused every template operator, as 1438 found for the onboarding pair), and the compliance_officer role held none of
--     support_consent_grant.list_own / issue / revoke (only org_admin and administrator, through the full catalog). Idempotent.
CREATE TABLE IF NOT EXISTS "support_session_event_default" PARTITION OF "support_session_event" DEFAULT;--> statement-breakpoint

-- ── support_consent_grant ────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "support_grant_org" ON "support_consent_grant";--> statement-breakpoint
DROP POLICY IF EXISTS "support_grant_org_read" ON "support_consent_grant";--> statement-breakpoint
CREATE POLICY "support_grant_org_read" ON "support_consent_grant"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "support_grant_org_issue" ON "support_consent_grant";--> statement-breakpoint
CREATE POLICY "support_grant_org_issue" ON "support_consent_grant"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND revoked_at IS NULL AND revoked_by_membership_id IS NULL AND revocation_reason IS NULL
  );--> statement-breakpoint
DROP POLICY IF EXISTS "support_grant_org_revoke" ON "support_consent_grant";--> statement-breakpoint
CREATE POLICY "support_grant_org_revoke" ON "support_consent_grant"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND revoked_at IS NULL
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND revoked_at IS NOT NULL
    AND revocation_reason IS NOT NULL
  );--> statement-breakpoint
REVOKE UPDATE ON "support_consent_grant" FROM chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by_membership_id", "revocation_reason") ON "support_consent_grant" TO chartwarden_app;--> statement-breakpoint

-- ── support_session ──────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "support_session_org" ON "support_session";--> statement-breakpoint
DROP POLICY IF EXISTS "support_session_org_read" ON "support_session";--> statement-breakpoint
CREATE POLICY "support_session_org_read" ON "support_session"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "support_session_org_close" ON "support_session";--> statement-breakpoint
CREATE POLICY "support_session_org_close" ON "support_session"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND closed_at IS NULL
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND closed_at IS NOT NULL
    AND close_reason = 'grant_revoked'
  );--> statement-breakpoint
REVOKE INSERT, UPDATE ON "support_session" FROM chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("closed_at", "close_reason") ON "support_session" TO chartwarden_app;--> statement-breakpoint

-- ── support_session_event (partitioned: the policies sit on the parent) ──────────────────────────────────
DROP POLICY IF EXISTS "support_session_event_org" ON "support_session_event";--> statement-breakpoint
DROP POLICY IF EXISTS "support_session_event_org_read" ON "support_session_event";--> statement-breakpoint
CREATE POLICY "support_session_event_org_read" ON "support_session_event"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "support_session_event_org_close" ON "support_session_event";--> statement-breakpoint
CREATE POLICY "support_session_event_org_close" ON "support_session_event"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND event_kind = 'session.close'
    AND patient_id IS NULL
  );--> statement-breakpoint

-- ── the platform carrier (only where scripts/db/provision-runtime-roles.ts has created it) ────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT INSERT ON "support_session" TO chartwarden_platform;
    REVOKE UPDATE ON "support_session" FROM chartwarden_platform;
    GRANT UPDATE ("closed_at", "close_reason") ON "support_session" TO chartwarden_platform;
    GRANT UPDATE ("revoked_at", "revoked_by_membership_id", "revocation_reason") ON "support_consent_grant" TO chartwarden_platform;
  END IF;
END $$;--> statement-breakpoint

-- ── the keys ─────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('support_session.list_platform'), ('support_session.start'), ('support_session.close')) AS k("key")
 WHERE r."key" = 'platform_ops'
   AND r."organization_id" IS NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('support_consent_grant.list_own'), ('support_consent_grant.issue'), ('support_consent_grant.revoke')) AS k("key")
 WHERE r."key" = 'compliance_officer'
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
