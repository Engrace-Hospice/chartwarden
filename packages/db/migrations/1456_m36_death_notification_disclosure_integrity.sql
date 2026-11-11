-- compat: contract
-- M36 death-notification disclosure integrity (builds on 1455; ADR-0098 amendment A10). `contract` because it TIGHTENS what the guard triggers
-- accept on existing columns (no column, constraint or grant changes), so a previous release could be refused a write it used to make; none of its
-- normal paths is (it writes link_id and the hash together with the `sent` settle, after minting the link), but the heuristic cannot see that.
-- CORRECTION to the 1455 header ("this is the backstop"): that wording covers LEGAL TRANSITIONS only. WHAT THE TRIGGERS ARE AND ARE NOT: they enforce the shape and the finality of the disclosure RECORD (legal transitions, a sent funeral-home notice
-- names a real link of the same org / patient / funeral home, the recipient digest and link id are final once sent, acked_by / acked_at belong to
-- `acked` only). They are NOT a BAA gate: whether a BAA is in force is decided by the service (M40 register) before the claim, re-checked when the
-- link is redeemed and on every funeral-home session read. A write that bypasses the service is still stopped from forging a "sent" row, but
-- nothing in the database checks the BAA.
-- pharmacy_vendor / dme_vendor (external kinds with NO transport and NO route yet): deliberately unchanged here. They carry no link and no
-- recipient digest, so the new link rules apply to funeral_home rows only; the whole external-vendor path gets its own rules when a transport exists.
-- Write-once rule (a deliberate narrowing of "never change"): link_id and recipient_email_hash are FINAL once the row is `sent` or `acked`. Before
-- that they may be set or replaced, because a send stranded in `sending` is swept to `failed` (its link revoked) and a re-send mints a new link.
-- The superseded link id stays in the audit trail (`m2.funeral.invited`).
CREATE OR REPLACE FUNCTION death_notification_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state NOT IN ('pending', 'failed', 'blocked_no_baa', 'not_applicable') THEN
    RAISE EXCEPTION 'death_notification_insert_state: a notification is never created % ', NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.link_id IS NOT NULL OR NEW.recipient_email_hash IS NOT NULL THEN
    RAISE EXCEPTION 'death_notification_insert_disclosure: a notification is created before anything is sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.send_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'death_notification_insert_attempt: a notification has no send attempt before claim' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.acked_by IS NOT NULL OR NEW.acked_at IS NOT NULL THEN
    RAISE EXCEPTION 'death_notification_insert_ack: a notification is never created acknowledged' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.funeral_home_entity_id IS NOT NULL
     AND (NEW.recipient_kind <> 'funeral_home' OR NEW.funeral_home_entity_id::text <> NEW.recipient_ref) THEN
    RAISE EXCEPTION 'death_notification_insert_entity: funeral_home_entity_id must be the funeral home recipient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION death_notification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_external boolean := NEW.recipient_kind IN ('funeral_home', 'pharmacy_vendor', 'dme_vendor');
  v_legal boolean;
BEGIN
  IF OLD.state = 'acked' THEN
    RAISE EXCEPTION 'death_notification_final: an acknowledged notification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  -- The disclosure record is final once sent: the link id and the recipient digest cannot be rewritten afterwards.
  IF OLD.state = 'sent'
     AND (NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.recipient_email_hash IS DISTINCT FROM OLD.recipient_email_hash) THEN
    RAISE EXCEPTION 'death_notification_disclosure_final: the link and recipient digest of a sent notice cannot change' USING ERRCODE = 'check_violation';
  END IF;
  -- acked_by / acked_at belong to `acked` only (the block below sets them for it).
  IF NEW.state <> 'acked' AND (NEW.acked_by IS NOT NULL OR NEW.acked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'death_notification_ack_state: acked_by / acked_at can only be set on an acknowledged notification' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    v_legal := CASE OLD.state
      WHEN 'pending'        THEN NEW.state IN ('sending', 'sent', 'acked', 'failed', 'blocked_no_baa', 'not_applicable')
      WHEN 'failed'         THEN NEW.state IN ('sending', 'blocked_no_baa')
      WHEN 'blocked_no_baa' THEN NEW.state IN ('sending', 'failed')
      WHEN 'sending'        THEN NEW.state IN ('sent', 'failed', 'blocked_no_baa', 'reconciling')
      WHEN 'reconciling'    THEN NEW.state = 'failed'
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
    IF NEW.state = 'sent' AND NEW.recipient_kind = 'funeral_home' THEN
      IF NEW.link_id IS NULL OR NEW.recipient_email_hash IS NULL THEN
        RAISE EXCEPTION 'death_notification_disclosure: a sent funeral-home notice records its link and recipient hash' USING ERRCODE = 'check_violation';
      END IF;
      -- The recorded link must be a real funeral link of THIS organization, patient and funeral home (RLS scopes the read to the session org).
      IF NOT EXISTS (
        SELECT 1 FROM collaborator_link l
         WHERE l.id = NEW.link_id
           AND l.organization_id = NEW.organization_id
           AND l.patient_id = NEW.patient_id
           AND l.kind = 'funeral_home'
           AND l.funeral_home_entity_id IS NOT NULL
           AND l.funeral_home_entity_id = NEW.funeral_home_entity_id
           AND l.disclosure_attempt_id = NEW.send_attempt_id
      ) THEN
        RAISE EXCEPTION 'death_notification_disclosure_link: the recorded link is not a funeral link for this organization, patient and funeral home' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.state = 'acked' AND v_external THEN
      RAISE EXCEPTION 'death_notification_transition: an external notice cannot be acknowledged' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.send_attempt_id IS DISTINCT FROM OLD.send_attempt_id
     AND NOT (NEW.state = 'sending' AND OLD.state IN ('pending', 'failed', 'blocked_no_baa')) THEN
    RAISE EXCEPTION 'death_notification_attempt_final: send_attempt_id changes only on a new claim' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.recipient_kind = 'funeral_home'
     AND NEW.state IN ('sending', 'reconciling', 'sent')
     AND NEW.send_attempt_id IS NULL THEN
    RAISE EXCEPTION 'death_notification_attempt_required: funeral-home sends require an attempt id' USING ERRCODE = 'check_violation';
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
