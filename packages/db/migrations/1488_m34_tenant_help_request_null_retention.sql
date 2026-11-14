-- compat: contract
-- M34 slice 7: remove retained help-request free text instead of keeping a fixed replacement in the database.
-- Migration 1483 is already applied and stays byte-identical. This follow-up permits NULL only after a request ended and the
-- 90-day retention trigger stamped message_purged_at; a new/live request can never use the API's retention placeholder path.

ALTER TABLE "tenant_help_request" ALTER COLUMN "message" DROP NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenant_help_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('resolved', 'cancelled') THEN
    -- Convert rows already purged by 1483 from its fixed placeholder to NULL. This branch becomes unreachable after this migration.
    IF OLD.message = '[removed after 90 days]' AND OLD.message_purged_at IS NOT NULL
       AND NEW.message IS NULL AND NEW.message_purged_at = OLD.message_purged_at
       AND NEW.status = OLD.status AND NEW.close_note IS NULL
       AND NEW.closed_by_actor_kind IS NOT DISTINCT FROM OLD.closed_by_actor_kind
       AND NEW.closed_by_user_id IS NOT DISTINCT FROM OLD.closed_by_user_id
       AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
       AND NEW.support_consent_grant_id IS NOT DISTINCT FROM OLD.support_consent_grant_id
       AND NEW.approved_by_membership_id IS NOT DISTINCT FROM OLD.approved_by_membership_id
       AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
      RETURN NEW;
    END IF;
    -- The one thing a closed request may do: lose its text, 90 days after it closed, once.
    IF NEW.status = OLD.status
       AND OLD.message_purged_at IS NULL AND NEW.message_purged_at IS NOT NULL
       AND OLD.closed_at <= now() - interval '90 days'
       AND NEW.message IS NULL AND NEW.close_note IS NULL
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
  IF NOT (OLD.status = 'open' AND NEW.status = 'approved') AND (
       NEW.support_consent_grant_id IS DISTINCT FROM OLD.support_consent_grant_id
       OR NEW.approved_by_membership_id IS DISTINCT FROM OLD.approved_by_membership_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'tenant_help_request_consent_fixed: the grant and approver change only when the request is approved' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.message IS DISTINCT FROM OLD.message OR NEW.message_purged_at IS DISTINCT FROM OLD.message_purged_at THEN
    RAISE EXCEPTION 'tenant_help_request_text_fixed: a live request keeps its message' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- A deployment may have run 1483's sweep already. Remove those placeholders before installing the new invariant.
UPDATE "tenant_help_request"
   SET "message" = NULL
 WHERE "message" = '[removed after 90 days]' AND "message_purged_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "tenant_help_request"
  ADD CONSTRAINT "tenant_help_request_message_retention_ck" CHECK (
    ("message" IS NOT NULL AND "message_purged_at" IS NULL)
    OR (
      "message" IS NULL
      AND "status" IN ('resolved', 'cancelled')
      AND "message_purged_at" IS NOT NULL
      AND "close_note" IS NULL
    )
  );
