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
--   · `context` of a TENANT row is therefore readable by the platform login in principle, and it is not only ids, hashes and
--     codes: the audit denylist catches named fields, not every free-text field, so a row can hold a short `reason` (break-glass,
--     destruction) or a `patientId` (a collaborator invitation). The platform login already reads cross-tenant tables
--     (`scripts/db/provision-runtime-roles.ts`), so this is an increment, not a new class of access, but it is not tightly
--     bounded. The grant is recorded in `compliance/controls.yaml` (CW-MON-01); a SECURITY DEFINER reader that returns only the
--     org-less authentication rows and the three scalar keys the review needs is the follow-up that would bound it.
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
