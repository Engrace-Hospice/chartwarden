-- 1146 — reserve the username 'chartwarden' (ChartWarden rebrand; 'wardenx' stays reserved).
--
-- Replaces user_username_not_reserved (1064) with the same list plus 'chartwarden'. The application
-- (RESERVED_USERNAMES in packages/auth) already rejects it; this makes the database agree.
--
-- Existing rows: a row that already holds username 'chartwarden' would fail a plain ADD CONSTRAINT and abort the
-- whole migration. So the constraint is added NOT VALID (enforced on every new INSERT and on every UPDATE of an
-- existing row), then VALIDATEd only when no row violates it. If a row does violate, validation is skipped with a
-- NOTICE and that account is left untouched (renaming a person's login is a manual decision). Until that user is
-- renamed, a NOT VALID CHECK is still evaluated when that one row is updated, so the rename itself (SET username)
-- is the unblocking write; afterwards run `ALTER TABLE "user" VALIDATE CONSTRAINT user_username_not_reserved`
-- (or re-run this file, which is idempotent in effect). The DROP + ADD run in one transaction, so there is no
-- window without the guard.
--
-- Locking: the runner wraps the whole file in one transaction, so the DROP's ACCESS EXCLUSIVE lock on "user" is held
-- through the VALIDATE scan (NOT VALID only spares the ADD, not the validation). That is one scan of a small table;
-- the risk is waiting behind a long-lived session, so the file fails fast instead of queueing every login behind the DROP.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint

ALTER TABLE "user" DROP CONSTRAINT "user_username_not_reserved";--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_username_not_reserved"
  CHECK (
    "username" IS NULL OR "username" NOT IN
      ('admin', 'administrator', 'root', 'security', 'support', 'system', 'wardenx', 'chartwarden')
  ) NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" WHERE "username" = 'chartwarden') THEN
    RAISE NOTICE 'user_username_not_reserved left NOT VALID: an existing user holds username ''chartwarden''; rename it, then VALIDATE CONSTRAINT';
  ELSE
    ALTER TABLE "user" VALIDATE CONSTRAINT "user_username_not_reserved";
  END IF;
END
$$;

-- Rollback (manual): ALTER TABLE "user" DROP CONSTRAINT "user_username_not_reserved"; then re-add the 1064 form.
