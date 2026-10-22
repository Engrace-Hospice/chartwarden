-- 1152 - drop the crypto label-backfill path that migration 1150 added (ChartWarden rename, RELEASE 3).
--
-- !!! DO NOT MERGE / DEPLOY BEFORE THE RELEASE-3 GATE IS MET !!!
-- This migration ships together with the release that REMOVES every legacy-label read path in the application (M5, M23, M24,
-- M34, M35, M36). From that release on, any value still sealed under a legacy `wardenx` label is PERMANENTLY UNREADABLE, and this
-- migration removes the only audited path that could have re-sealed the four owner-isolated M36 tables. Do not merge until ALL of:
--   1. release 2 is merged and deployed on every node (so every writer emits the chartwarden labels);
--   2. the operator ran the backfill in production AND `bun run crypto-labels:verify -- --all-orgs`, run from the RELEASE-2 build,
--      reported legacyOnlyTotal 0, problemTotal 0 and complete true - measured again right before this merge;
--   3. at least 24 h have passed since the last pre-flip M36 export job became ready (its wrapped key expires then);
--   4. no legal hold is still causing the backfill to skip a message;
--   5. a fresh, restorable backup exists.
-- Restoring a PRE-backfill backup after this release brings back rows sealed under the legacy labels, which this release cannot
-- open. Restore only a backup taken after the backfill completed.
--
-- What this drops (everything 1150 created, marked RELEASE-3-DROP there):
--   - m36_label_backfill_page / m36_label_backfill_swap (the SECURITY DEFINER read + compare-and-swap of the sealed values);
--   - the eight org-pinned *_label_backfill_* policies and the eight column grants given to chartwarden_label_backfill_owner;
--   - the owner role itself (NOLOGIN; nothing else depends on it).
-- What it deliberately keeps: chartwarden_m36_reseal and its login chartwarden_body_backfill_login. 1090 / 1094 created them for the
-- legacy->ring body migration (m36:body-backfill), which is still a supported tool; 1150 only granted EXECUTE on its two functions
-- to that carrier, and those grants go with the functions. The login therefore needs no revoke here (it keeps exactly the reach
-- it had before 1150, and stays operator-only).
--
-- Idempotent: every statement is IF EXISTS. Multi-database clusters: the role is cluster-global, so the DROP ROLE is attempted
-- last and, if a sibling database still holds objects owned by it (not yet migrated), is skipped with a NOTICE; the role is then
-- inert (NOLOGIN, no grants here) and the last database to run this migration removes it.

DROP FUNCTION IF EXISTS m36_label_backfill_page(text, uuid, uuid, integer);--> statement-breakpoint
DROP FUNCTION IF EXISTS m36_label_backfill_swap(text, uuid, uuid, bytea, bytea);--> statement-breakpoint

DROP POLICY IF EXISTS "message_revision_label_backfill_select" ON "message_revision";--> statement-breakpoint
DROP POLICY IF EXISTS "message_revision_label_backfill_update" ON "message_revision";--> statement-breakpoint
DROP POLICY IF EXISTS "message_poll_option_label_backfill_select" ON "message_poll_option";--> statement-breakpoint
DROP POLICY IF EXISTS "message_poll_option_label_backfill_update" ON "message_poll_option";--> statement-breakpoint
DROP POLICY IF EXISTS "message_draft_label_backfill_select" ON "message_draft";--> statement-breakpoint
DROP POLICY IF EXISTS "message_draft_label_backfill_update" ON "message_draft";--> statement-breakpoint
DROP POLICY IF EXISTS "scheduled_message_label_backfill_select" ON "scheduled_message";--> statement-breakpoint
DROP POLICY IF EXISTS "scheduled_message_label_backfill_update" ON "scheduled_message";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_label_backfill_owner') THEN
    REVOKE ALL ON "message_revision", "message_poll_option", "message_draft", "scheduled_message"
      FROM chartwarden_label_backfill_owner;
    REVOKE ALL ON SCHEMA public FROM chartwarden_label_backfill_owner;
    -- Anything still owned by or granted to the role in THIS database (nothing is expected after the statements above).
    EXECUTE 'DROP OWNED BY chartwarden_label_backfill_owner';
    BEGIN
      DROP ROLE chartwarden_label_backfill_owner;
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE NOTICE '1152: chartwarden_label_backfill_owner is still referenced in another database of this cluster; it is inert (NOLOGIN, no grants here) and the last database to run 1152 will drop it';
    END;
  END IF;
END $$;
