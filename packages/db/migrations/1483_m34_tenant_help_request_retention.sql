-- compat: contract
-- M34 slice 7 (piece 7B), round 2: what migration 1482's review asked the database to hold.
--
-- 1. RETENTION OF FREE TEXT. A help request's message and an operator's close note are text a person typed; the PHI screen is a
--    best-effort pattern match, so a name or a date of birth can still get through. The text is therefore kept only as long as it
--    is useful: 90 days after a request closes (resolved or cancelled) the sweep replaces the message with a fixed placeholder and
--    clears the note, stamping `message_purged_at`. The DATABASE holds the rule, not only the sweep: the guard trigger below lets a
--    closed request change in exactly this one way (the placeholder, a cleared note, the stamp, nothing else), never before the 90
--    days are up (the trigger reads the transaction's own `now()`), and never twice. The platform carrier gets the column UPDATE this
--    needs on `message` and `message_purged_at` (`close_note` it already had); the tenant role gets nothing new, so a member can still
--    never edit a message. (`message` stays NOT NULL with its 8..1000 CHECK, so the purged text is a placeholder, not a NULL; every
--    response shape stays what it was.)
--
-- 2. THE GUARD TRIGGER PINS THE CONSENT COLUMNS ON EVERY MOVE BUT THE APPROVAL. 1482's trigger fixed an approved request's grant,
--    approver and approval time; an `open` request could still be closed with those columns set to anything (reachable only with SQL
--    control of the tenant pool, since the service never does it). Now `support_consent_grant_id`, `approved_by_membership_id` and
--    `approved_at` change only on open -> approved.
--
-- 3. THE APPROVE BRANCH OF THE TENANT UPDATE POLICY REQUIRES A LIVE GRANT: not revoked and not past its expiry (it was correct only
--    because the service issues the grant on the same transaction), and the grant link is unique (one request per grant), so a grant
--    can never answer two requests. The `assist` scope is not pinned here: its enum value arrives with the support-session migration
--    (1481), and this file must not depend on it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS, CREATE ... IF NOT EXISTS). 1482 is unchanged.
ALTER TABLE "tenant_help_request" ADD COLUMN IF NOT EXISTS "message_purged_at" timestamp with time zone;--> statement-breakpoint
-- The sweep's scan: closed requests whose text has not been purged yet, oldest first.
CREATE INDEX IF NOT EXISTS "tenant_help_request_purge_ix" ON "tenant_help_request" ("closed_at")
  WHERE "message_purged_at" IS NULL AND "status" IN ('resolved', 'cancelled');--> statement-breakpoint
-- One request per consent grant (1482's plain grant_ix stays: it is the foreign key's own index).
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_help_request_grant_uq" ON "tenant_help_request" ("support_consent_grant_id")
  WHERE "support_consent_grant_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenant_help_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('resolved', 'cancelled') THEN
    -- The one thing a closed request may do: lose its text, 90 days after it closed, once.
    IF NEW.status = OLD.status
       AND OLD.message_purged_at IS NULL AND NEW.message_purged_at IS NOT NULL
       AND OLD.closed_at <= now() - interval '90 days'
       AND NEW.message = '[removed after 90 days]' AND NEW.close_note IS NULL
       AND NEW.closed_by_actor_kind IS NOT DISTINCT FROM OLD.closed_by_actor_kind
       AND NEW.closed_by_user_id IS NOT DISTINCT FROM OLD.closed_by_user_id
       AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
       AND NEW.support_consent_grant_id IS NOT DISTINCT FROM OLD.support_consent_grant_id
       AND NEW.approved_by_membership_id IS NOT DISTINCT FROM OLD.approved_by_membership_id
       AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tenant_help_request_transition: a closed request changes only by losing its text after 90 days' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('approved', 'resolved', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status = 'resolved')) THEN
    RAISE EXCEPTION 'tenant_help_request_transition: % -> % is not a legal move', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- the consent link, the approver and the approval time are set by the approval and by nothing else
  IF NOT (OLD.status = 'open' AND NEW.status = 'approved') AND (
       NEW.support_consent_grant_id IS DISTINCT FROM OLD.support_consent_grant_id
       OR NEW.approved_by_membership_id IS DISTINCT FROM OLD.approved_by_membership_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'tenant_help_request_consent_fixed: the grant and approver change only when the request is approved' USING ERRCODE = 'check_violation';
  END IF;
  -- the text a person typed is never rewritten while the request is live
  IF NEW.message IS DISTINCT FROM OLD.message OR NEW.message_purged_at IS DISTINCT FROM OLD.message_purged_at THEN
    RAISE EXCEPTION 'tenant_help_request_text_fixed: a live request keeps its message' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 1482's approve and end branches, with the approval's grant now required to be live.
DROP POLICY IF EXISTS "tenant_help_request_org_update" ON "tenant_help_request";--> statement-breakpoint
CREATE POLICY "tenant_help_request_org_update" ON "tenant_help_request"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status IN ('open', 'approved')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND (
      (
        status = 'approved'
        AND support_consent_grant_id IS NOT NULL AND approved_at IS NOT NULL
        AND closed_by_actor_kind IS NULL AND closed_by_user_id IS NULL AND closed_at IS NULL AND close_note IS NULL
        AND EXISTS (
          SELECT 1 FROM membership m
           WHERE m.id = tenant_help_request.approved_by_membership_id
             AND m.organization_id = tenant_help_request.organization_id
             AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
             AND m.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM support_consent_grant g
           WHERE g.id = tenant_help_request.support_consent_grant_id
             AND g.organization_id = tenant_help_request.organization_id
             AND g.tenant_account_id = tenant_help_request.tenant_account_id
             AND g.revoked_at IS NULL
             AND g.expires_at > now()
        )
      )
      OR (
        status IN ('resolved', 'cancelled')
        AND closed_by_actor_kind = 'tenant'
        AND closed_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND closed_at IS NOT NULL
        AND close_note IS NULL
      )
    )
  );--> statement-breakpoint

-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    -- the retention sweep replaces a closed request's message with the placeholder (the guard trigger holds when and how)
    GRANT UPDATE ("message", "message_purged_at") ON "tenant_help_request" TO chartwarden_platform;
  END IF;
END $$;
