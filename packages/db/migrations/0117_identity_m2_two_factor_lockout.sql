-- M2 Identity §3.3 — `two_factor` gains the Better Auth two-factor LOCKOUT columns.
--
-- WHY THIS EXISTS. The `better-auth` bump shipped in the 2026-06-27 audit remediation moved the
-- two-factor plugin's model forward by two fields (`node_modules/better-auth/dist/plugins/two-factor/
-- schema.mjs`): `failedVerificationCount` (number, default 0) and `lockedUntil` (date). The Drizzle
-- schema was not moved with it, so the adapter threw on the FIRST 2FA write:
--
--     BetterAuthError: The field "failedVerificationCount" does not exist in the "twoFactor"
--     Drizzle schema.
--
-- That broke enrolment outright — and, less visibly, meant the plugin's brute-force lockout had no
-- columns to record into, so a security control the dependency believed it was enforcing was simply
-- absent. The only test that would have caught it is `test:auth:live`, which needs a real Postgres and
-- therefore never runs in the default `bun run test`; its CI job existed but the repo is 127 commits
-- ahead of origin, so nothing had executed it.
--
-- BOTH COLUMNS ARE NULLABLE / DEFAULTED, so this is a safe online add on a populated table:
--   * `failed_verification_count` NOT NULL DEFAULT 0 — Postgres 11+ stores the default in the catalog
--     rather than rewriting the heap, so no table rewrite and no long ACCESS EXCLUSIVE hold.
--   * `locked_until` NULL — "not currently locked out". A NULL here means no lockout is in force, which
--     is the correct reading for every row that predates the feature.
--
-- No RLS/grant change: `two_factor` is USER-owned and NON_ORG_SCOPED (its policy keys on the owning
-- user, not `app.org_id`), and the existing policy + grants already cover every column on the table.
-- No M4 write-audit trigger change either — the trigger is per-TABLE and already installed (0006).

ALTER TABLE two_factor
  ADD COLUMN IF NOT EXISTS failed_verification_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

COMMENT ON COLUMN two_factor.failed_verification_count IS
  'Consecutive failed second-factor verifications; reset to 0 on success. Written by the better-auth two-factor plugin (M2 §3.3).';
COMMENT ON COLUMN two_factor.locked_until IS
  'When set and in the future, second-factor verification is locked out for this enrolment. NULL = not locked.';
