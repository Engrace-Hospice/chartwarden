-- FIXTURE. The acknowledgment-request actor guards may read app.user_id (an authorization backstop, not an RLS predicate), but ONLY
-- in a statement that starts with CREATE [OR REPLACE] FUNCTION of exactly those functions. A name mentioned elsewhere in the
-- statement - a comment, a body, a policy string - buys nothing.

-- 1. The real shape: exempt, so it must stay silent.
CREATE OR REPLACE FUNCTION message_ack_request_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.user_id', true), '') IS NULL THEN RETURN NEW; END IF;
  RETURN NEW;
END $$;

-- 2. Another function that only MENTIONS the guard's name: reported (the old bare-substring test exempted it).
CREATE OR REPLACE FUNCTION fixture_other_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- see message_ack_request_update_guard for the real one
  IF NULLIF(current_setting('app.user_id', true), '') IS NULL THEN RETURN NEW; END IF;
  RETURN NEW;
END $$;

-- 3. A policy string carrying the name: reported (a policy is never exempt).
DO $$
BEGIN
  EXECUTE 'CREATE POLICY fixture_ack_dyn ON fixture_ack FOR ALL TO chartwarden_app USING (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid) -- message_ack_request_update_guard';
END $$;
