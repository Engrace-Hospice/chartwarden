-- FIXTURE. The system-managed role key guard may read app.system_role_writer (an authorization marker, not an RLS predicate), but
-- ONLY in a statement that starts with CREATE [OR REPLACE] FUNCTION of exactly that function. A name mentioned elsewhere buys nothing.

-- 1. The real shape: exempt, so it must stay silent.
CREATE OR REPLACE FUNCTION role_system_managed_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('app.system_role_writer', true), '') = 'auditor_grant' THEN RETURN NEW; END IF;
  RETURN NEW;
END $$;

-- 2. Another function that only MENTIONS the guard's name: reported.
CREATE OR REPLACE FUNCTION fixture_other_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- see role_system_managed_key_guard for the real one
  IF COALESCE(current_setting('app.system_role_writer', true), '') = 'auditor_grant' THEN RETURN NEW; END IF;
  RETURN NEW;
END $$;
