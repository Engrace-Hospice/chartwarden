-- compat: expand
-- CW-MON-01 — the security review's platform lane reads the ORG-LESS authentication events (login, failed login, lockout:
-- `organization_id IS NULL`, written by the SECURITY DEFINER platform writer, migration 0187) that no tenant context can read.
-- It runs on the platform login (`chartwarden_platform_login`, BYPASSRLS) under an audited `withPlatformContext`
-- (job id `m4.security_review`), so the carrier needs SELECT on the few columns the review reads — nothing else:
-- never `before`, `after`, `user_agent`, `source_ip` or the request/trace ids.
--
-- Two limits, stated rather than implied:
--   · BYPASSRLS means no policy narrows this grant to org-less rows; the review's own `organization_id IS NULL` predicate does,
--     and `m4-security-review.live.test.ts` proves a tenant's rows are never returned by the platform lane. The column list is the
--     database-side bound.
--   · `context` of a tenant row is therefore readable by the platform login in principle. It holds ids, hashes and codes
--     (the audit denylist runs before every write) and the platform login already reads cross-tenant tables
--     (`scripts/db/provision-runtime-roles.ts`); the grant is recorded in `compliance/controls.yaml` (CW-MON-01).
--
-- The carrier exists only where provision-runtime-roles.ts has run; that script re-grants the same columns on every run, so a
-- database provisioned AFTER this migration gets the grant from the script, and one provisioned BEFORE gets it here.
-- Additive and idempotent: a GRANT narrows nothing and removes nothing.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ("id", "created_at", "organization_id", "actor_user_id", "event_type", "context")
      ON "audit_event" TO chartwarden_platform;
  END IF;
END $$;
