-- compat: contract
-- M36 death-notification funeral-home send hardening (builds on 1305; ADR-0098 amendment A8). `contract` because widening the state CHECK is a
-- DROP CONSTRAINT + ADD CONSTRAINT (the heuristic cannot tell that it only ADDS an allowed value); no column is dropped or narrowed and the only
-- new columns are nullable, so a previous release keeps running against this schema.
--   * state `sending`: the compare-and-set claim a funeral-home send takes BEFORE it mints a link, so of any number of concurrent sends exactly
--     one mints. A row left `sending` (crash, or sent-but-unrecorded) is never re-claimable: a retry cannot mint a second link.
--   * death_notification.funeral_home_entity_id / link_id / recipient_email_hash: what an accounting of disclosures joins on (patient_id is on the
--     row already). The hash is SHA-256 over org id + the normalised address, salted per tenant; the address itself is never stored.
--   * collaborator_link.funeral_home_entity_id: the funeral home the BAA was checked for, re-checked at redemption (null on older links).
--   * the triggers now enforce LEGAL TRANSITIONS (the service checks first, this is the backstop): a row is born pending / failed /
--     blocked_no_baa / not_applicable only (never sent, sending or acked); an external notice reaches `sent` only from `sending` and carries its
--     link id and recipient hash; `acked` is for internal kinds only and acked_by is forced to the session user (app.user_id), whatever the
--     client sends.
ALTER TABLE "collaborator_link" ADD COLUMN "funeral_home_entity_id" uuid;--> statement-breakpoint

ALTER TABLE "death_notification" ADD COLUMN "funeral_home_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "death_notification" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "death_notification" ADD COLUMN "recipient_email_hash" text;--> statement-breakpoint
ALTER TABLE "death_notification" DROP CONSTRAINT "death_notification_state_shape";--> statement-breakpoint
ALTER TABLE "death_notification" ADD CONSTRAINT "death_notification_state_shape" CHECK ("state" IN
  ('pending', 'sending', 'sent', 'acked', 'failed', 'blocked_no_baa', 'not_applicable'));--> statement-breakpoint
ALTER TABLE "death_notification" ADD CONSTRAINT "death_notification_recipient_hash_shape"
  CHECK ("recipient_email_hash" IS NULL OR "recipient_email_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
GRANT UPDATE ("link_id", "recipient_email_hash") ON "death_notification" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION death_notification_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('pending', 'failed', 'blocked_no_baa', 'not_applicable') THEN
    RAISE EXCEPTION 'death_notification_insert_state: a notification is never created % ', NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.link_id IS NOT NULL OR NEW.recipient_email_hash IS NOT NULL THEN
    RAISE EXCEPTION 'death_notification_insert_disclosure: a notification is created before anything is sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.funeral_home_entity_id IS NOT NULL
     AND (NEW.recipient_kind <> 'funeral_home' OR NEW.funeral_home_entity_id::text <> NEW.recipient_ref) THEN
    RAISE EXCEPTION 'death_notification_insert_entity: funeral_home_entity_id must be the funeral home recipient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- Legal transitions, finality, the database clock and the acknowledging actor. SECURITY INVOKER.
CREATE OR REPLACE FUNCTION death_notification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_external boolean := NEW.recipient_kind IN ('funeral_home', 'pharmacy_vendor', 'dme_vendor');
  v_legal boolean;
BEGIN
  IF OLD.state = 'acked' THEN
    RAISE EXCEPTION 'death_notification_final: an acknowledged notification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    v_legal := CASE OLD.state
      WHEN 'pending'        THEN NEW.state IN ('sending', 'sent', 'acked', 'failed', 'blocked_no_baa', 'not_applicable')
      WHEN 'failed'         THEN NEW.state IN ('sending', 'blocked_no_baa')
      WHEN 'blocked_no_baa' THEN NEW.state IN ('sending', 'failed')
      WHEN 'sending'       THEN NEW.state IN ('sent', 'failed')
      WHEN 'sent'           THEN NEW.state = 'acked'
      ELSE false END;
    IF NOT v_legal THEN
      RAISE EXCEPTION 'death_notification_transition: % -> % is not a legal transition', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'sending' AND NOT v_external THEN
      RAISE EXCEPTION 'death_notification_transition: only an external notice is sent through a claim' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'sent' AND v_external AND OLD.state <> 'sending' THEN
      RAISE EXCEPTION 'death_notification_transition: an external notice is sent only from a claimed (sending) row' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'sent' AND NEW.recipient_kind = 'funeral_home' AND (NEW.link_id IS NULL OR NEW.recipient_email_hash IS NULL) THEN
      RAISE EXCEPTION 'death_notification_disclosure: a sent funeral-home notice records its link and recipient hash' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'acked' AND v_external THEN
      RAISE EXCEPTION 'death_notification_transition: an external notice cannot be acknowledged' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.state = 'acked' THEN
    NEW.acked_at := now();
    NEW.acked_by := nullif(current_setting('app.user_id', true), '')::uuid;
    IF NEW.acked_by IS NULL THEN
      RAISE EXCEPTION 'death_notification_ack_actor: an acknowledgment needs a signed-in user' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
