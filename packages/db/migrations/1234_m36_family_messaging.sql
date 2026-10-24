-- M36 WP 6.7 (ADR-0099, PROPOSED), slice S1 - family / caregiver messaging without an app. A consented person (an M5 patient_caregiver) reaches ONE
-- dedicated `family` conversation through a one-time link plus an out-of-band code. Flag messaging.family_messaging (absent = off) gates creating an
-- invitation and EVERY contact route; list, revoke, close and block never depend on it.
--   * message_family_setting: the tenant's neutral agency name and the two numbers the not-an-emergency notice must show (D7, D14, D15).
--   * message_family_contact: the thread link, one row per (organization, patient_caregiver). Names the lazily created `family` channel, the mode
--     (standard / bereavement), close and block (a block is lifted only by a SECOND person), and the activity instants the staff lane reads.
--   * message_family_invitation: one-time link + code, hashes only. Single use, 5 attempts that never reset (a staff REISSUE is a NEW row that
--     supersedes the old one), at most 30 days. At most one live (unrevoked) row per contact.
--   * message_family_session: the contact's bearer (hash only): enrolment -> active (forward only, rotating the bearer), 12 h absolute, never past
--     the invitation. A revoked or expired invitation kills every session of it on the next request: nothing is cached.
--   * message_family_access: one insert-only row per contact read or send. Its guard refuses the row unless the session is ACTIVE and the invitation
--     live NOW, so an access that cannot be recorded is refused by the database as well. Ids and counts only, never message text.
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS. A contact request runs under the organisation only (no
--     app.user_id); every staff-only transition below demands app.user_id.
--   * Tenancy: organization_id on every table, FORCEd RLS on app.org_id; the table that carries a patient also carries the nullable
--     provider_entity_id / location_id of the three-column rule. Audit rows scrub the patient and caregiver ids and omit the hashes.

CREATE TABLE "message_family_setting" (
  "organization_id" uuid PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "agency_name" text,
  "agency_phone" text,
  "bereavement_phone" text,
  "updated_by" uuid REFERENCES "user"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_family_setting_name_len" CHECK ("agency_name" IS NULL OR char_length(btrim("agency_name")) BETWEEN 1 AND 120),
  CONSTRAINT "message_family_setting_phone_len" CHECK ("agency_phone" IS NULL OR char_length(btrim("agency_phone")) BETWEEN 1 AND 120),
  CONSTRAINT "message_family_setting_berv_len" CHECK ("bereavement_phone" IS NULL OR char_length(btrim("bereavement_phone")) BETWEEN 1 AND 120)
);--> statement-breakpoint
CREATE INDEX "message_family_setting_updated_by_idx" ON "message_family_setting" ("updated_by") WHERE "updated_by" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_setting_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF v_actor IS NULL OR NEW.updated_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'message_family_setting_actor: a setting is changed only by the acting user' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_family_setting_guard"
  BEFORE INSERT OR UPDATE ON "message_family_setting"
  FOR EACH ROW EXECUTE FUNCTION message_family_setting_guard();--> statement-breakpoint

CREATE TABLE "message_family_contact" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "patient_caregiver_id" uuid NOT NULL,
  "channel_id" uuid,
  "created_by" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "mode" text DEFAULT 'standard' NOT NULL,
  "mode_changed_at" timestamptz,
  "closed_at" timestamptz,
  "closed_by" uuid REFERENCES "user"("id"),
  "blocked_at" timestamptz,
  "blocked_by" uuid REFERENCES "user"("id"),
  "last_contact_message_at" timestamptz,
  "last_staff_reply_at" timestamptz,
  "staff_seen_through" timestamptz,
  CONSTRAINT "message_family_contact_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_family_contact_person_unique" UNIQUE ("organization_id", "patient_caregiver_id"),
  CONSTRAINT "message_family_contact_channel_unique" UNIQUE ("organization_id", "channel_id"),
  CONSTRAINT "message_family_contact_mode" CHECK ("mode" IN ('standard', 'bereavement')),
  CONSTRAINT "message_family_contact_closed_pair" CHECK (("closed_at" IS NULL) = ("closed_by" IS NULL)),
  CONSTRAINT "message_family_contact_blocked_pair" CHECK (("blocked_at" IS NULL) = ("blocked_by" IS NULL)),
  CONSTRAINT "message_family_contact_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE SET NULL ("channel_id")
);--> statement-breakpoint
CREATE INDEX "message_family_contact_patient_idx" ON "message_family_contact" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX "message_family_contact_created_by_idx" ON "message_family_contact" ("created_by");--> statement-breakpoint
CREATE INDEX "message_family_contact_closed_by_idx" ON "message_family_contact" ("closed_by") WHERE "closed_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_family_contact_blocked_by_idx" ON "message_family_contact" ("blocked_by") WHERE "blocked_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_family_contact_provider_entity_idx" ON "message_family_contact" ("provider_entity_id") WHERE "provider_entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_family_contact_location_idx" ON "message_family_contact" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_contact_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_family_contact_actor: a contact is recorded only by the staff member who invites' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.channel_id := NULL; NEW.mode := 'standard'; NEW.mode_changed_at := NULL;
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.blocked_at := NULL; NEW.blocked_by := NULL;
    NEW.last_contact_message_at := NULL; NEW.last_staff_reply_at := NULL; NEW.staff_seen_through := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['channel_id','mode','mode_changed_at','closed_at','closed_by','blocked_at','blocked_by','last_contact_message_at','last_staff_reply_at','staff_seen_through'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['channel_id','mode','mode_changed_at','closed_at','closed_by','blocked_at','blocked_by','last_contact_message_at','last_staff_reply_at','staff_seen_through']) THEN
    RAISE EXCEPTION 'message_family_contact_immutable: the person, the patient and the tenancy columns never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id AND OLD.channel_id IS NOT NULL THEN
    RAISE EXCEPTION 'message_family_contact_channel: the conversation is named once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    IF NOT (OLD.mode = 'standard' AND NEW.mode = 'bereavement') THEN
      RAISE EXCEPTION 'message_family_contact_mode: standard -> bereavement, once' USING ERRCODE = 'check_violation';
    END IF;
    NEW.mode_changed_at := now();
  END IF;
  IF NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
    IF v_actor IS NULL OR (NEW.closed_at IS NOT NULL AND NEW.closed_by IS DISTINCT FROM v_actor) THEN
      RAISE EXCEPTION 'message_family_contact_close: a thread is closed or reopened by the acting staff member' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.closed_at IS NOT NULL THEN NEW.closed_at := now(); END IF;
  END IF;
  IF NEW.blocked_at IS DISTINCT FROM OLD.blocked_at OR NEW.blocked_by IS DISTINCT FROM OLD.blocked_by THEN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'message_family_contact_block: a block changes only by the acting staff member' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.blocked_at IS NOT NULL THEN
      IF OLD.blocked_at IS NOT NULL OR NEW.blocked_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'message_family_contact_block: blocked once, by the acting staff member' USING ERRCODE = 'check_violation';
      END IF;
      NEW.blocked_at := now();
    ELSIF OLD.blocked_by = v_actor THEN
      -- ADR-0099 D8: lifting a block needs a second authoriser, never the person who blocked.
      RAISE EXCEPTION 'message_family_contact_unblock: a block is lifted by a second person' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.last_contact_message_at IS NOT NULL AND OLD.last_contact_message_at IS NOT NULL AND NEW.last_contact_message_at < OLD.last_contact_message_at)
     OR (NEW.last_staff_reply_at IS NOT NULL AND OLD.last_staff_reply_at IS NOT NULL AND NEW.last_staff_reply_at < OLD.last_staff_reply_at)
     OR (NEW.staff_seen_through IS NOT NULL AND OLD.staff_seen_through IS NOT NULL AND NEW.staff_seen_through < OLD.staff_seen_through) THEN
    RAISE EXCEPTION 'message_family_contact_activity: activity instants only move forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_family_contact_guard"
  BEFORE INSERT OR UPDATE ON "message_family_contact"
  FOR EACH ROW EXECUTE FUNCTION message_family_contact_guard();--> statement-breakpoint

CREATE TABLE "message_family_invitation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "contact_id" uuid NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "invite_token_hash" text NOT NULL,
  "code_hash" text NOT NULL,
  "code_attempts" integer DEFAULT 0 NOT NULL,
  "invite_redeemed_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by" uuid REFERENCES "user"("id"),
  "revoke_reason" text,
  CONSTRAINT "message_family_invitation_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_family_invitation_token_unique" UNIQUE ("invite_token_hash"),
  CONSTRAINT "message_family_invitation_attempts" CHECK ("code_attempts" BETWEEN 0 AND 5),
  CONSTRAINT "message_family_invitation_expiry" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "message_family_invitation_revoke_reason" CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN ('staff', 'superseded', 'blocked')),
  CONSTRAINT "message_family_invitation_revoke_pair" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
  CONSTRAINT "message_family_invitation_revoked_by" CHECK ("revoked_by" IS NULL OR "revoked_at" IS NOT NULL),
  CONSTRAINT "message_family_invitation_contact_fk"
    FOREIGN KEY ("organization_id", "contact_id")
    REFERENCES "message_family_contact"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX "message_family_invitation_one_live" ON "message_family_invitation" ("organization_id", "contact_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_family_invitation_created_idx" ON "message_family_invitation" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "message_family_invitation_created_by_idx" ON "message_family_invitation" ("created_by", "created_at");--> statement-breakpoint
CREATE INDEX "message_family_invitation_revoked_by_idx" ON "message_family_invitation" ("revoked_by") WHERE "revoked_by" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_invitation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_family_invitation_actor: an invitation is recorded only by its creator' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.revoked_at := NULL; NEW.revoked_by := NULL; NEW.revoke_reason := NULL; NEW.invite_redeemed_at := NULL; NEW.code_attempts := 0;
    RETURN NEW;
  END IF;
  -- Everything except the three lifecycle facts is frozen for good (the contact, both hashes, the expiry). A reissue is a NEW row.
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revoke_reason','invite_redeemed_at','code_attempts'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revoke_reason','invite_redeemed_at','code_attempts']) THEN
    RAISE EXCEPTION 'message_family_invitation_immutable: only revoke, redemption and the attempt counter change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason THEN
    IF OLD.revoked_at IS NOT NULL OR v_actor IS NULL OR NEW.revoked_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_family_invitation_revoke: an invitation is revoked once, by the acting staff member' USING ERRCODE = 'check_violation';
    END IF;
    NEW.revoked_at := now();
  END IF;
  IF NEW.invite_redeemed_at IS DISTINCT FROM OLD.invite_redeemed_at THEN
    IF OLD.invite_redeemed_at IS NOT NULL THEN
      RAISE EXCEPTION 'message_family_invitation_redeemed: the link is single use' USING ERRCODE = 'check_violation';
    END IF;
    NEW.invite_redeemed_at := now();
  END IF;
  IF NEW.code_attempts IS DISTINCT FROM OLD.code_attempts AND NEW.code_attempts <> OLD.code_attempts + 1 THEN
    RAISE EXCEPTION 'message_family_invitation_attempts: the counter only goes up by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_family_invitation_guard"
  BEFORE INSERT OR UPDATE ON "message_family_invitation"
  FOR EACH ROW EXECUTE FUNCTION message_family_invitation_guard();--> statement-breakpoint

CREATE TABLE "message_family_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "invitation_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "stage" text DEFAULT 'enrolment' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "activated_at" timestamptz,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_family_session_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_family_session_token_unique" UNIQUE ("token_hash"),
  CONSTRAINT "message_family_session_stage" CHECK ("stage" IN ('enrolment', 'active')),
  CONSTRAINT "message_family_session_lifetime" CHECK ("expires_at" <= "created_at" + interval '12 hours'),
  CONSTRAINT "message_family_session_stage_pair" CHECK (("stage" = 'active') = ("activated_at" IS NOT NULL)),
  CONSTRAINT "message_family_session_invitation_fk"
    FOREIGN KEY ("organization_id", "invitation_id")
    REFERENCES "message_family_invitation"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_family_session_invitation_idx" ON "message_family_session" ("organization_id", "invitation_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_session_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.stage := 'enrolment'; NEW.activated_at := NULL; NEW.created_at := now(); NEW.last_seen_at := now();
    -- Born only against a live, redeemed invitation, never outliving it or 12 hours.
    IF NOT EXISTS (
      SELECT 1 FROM message_family_invitation i
       WHERE i.organization_id = NEW.organization_id AND i.id = NEW.invitation_id
         AND i.revoked_at IS NULL AND i.expires_at > now() AND i.invite_redeemed_at IS NOT NULL
         AND NEW.expires_at <= i.expires_at AND NEW.expires_at > now() AND NEW.expires_at <= now() + interval '12 hours') THEN
      RAISE EXCEPTION 'message_family_session_invitation: a session needs a live, redeemed invitation and cannot outlive it or 12 hours' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['stage','activated_at','token_hash','last_seen_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['stage','activated_at','token_hash','last_seen_at']) THEN
    RAISE EXCEPTION 'message_family_session_immutable: only the stage, the bearer hash and the last-seen instant change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    -- Activation ROTATES the bearer: the stage and the hash change together, once.
    IF NOT (OLD.stage = 'enrolment' AND NEW.stage = 'active' AND NEW.token_hash <> OLD.token_hash) THEN
      RAISE EXCEPTION 'message_family_session_stage: enrolment -> active rotates the bearer, once' USING ERRCODE = 'check_violation';
    END IF;
    NEW.activated_at := now();
  ELSIF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'message_family_session_immutable: the activation instant is set by the activation' USING ERRCODE = 'check_violation';
  END IF;
  NEW.last_seen_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_family_session_guard"
  BEFORE INSERT OR UPDATE ON "message_family_session"
  FOR EACH ROW EXECUTE FUNCTION message_family_session_guard();--> statement-breakpoint

CREATE TABLE "message_family_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "contact_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "action" text NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "message_id" uuid,
  "accessed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_family_access_action" CHECK ("action" IN ('read', 'send')),
  CONSTRAINT "message_family_access_count" CHECK ("message_count" >= 0),
  CONSTRAINT "message_family_access_send_shape" CHECK (("action" = 'send') = ("message_id" IS NOT NULL)),
  CONSTRAINT "message_family_access_contact_fk"
    FOREIGN KEY ("organization_id", "contact_id")
    REFERENCES "message_family_contact"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_family_access_session_fk"
    FOREIGN KEY ("organization_id", "session_id")
    REFERENCES "message_family_session"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_family_access_contact_idx" ON "message_family_access" ("organization_id", "contact_id", "accessed_at");--> statement-breakpoint
CREATE INDEX "message_family_access_session_idx" ON "message_family_access" ("organization_id", "session_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_family_access_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.accessed_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM message_family_session x
      JOIN message_family_invitation i ON i.organization_id = x.organization_id AND i.id = x.invitation_id
      JOIN message_family_contact c ON c.organization_id = i.organization_id AND c.id = i.contact_id
     WHERE x.organization_id = NEW.organization_id AND x.id = NEW.session_id AND c.id = NEW.contact_id
       AND x.stage = 'active' AND x.expires_at > now() AND x.last_seen_at > now() - interval '30 minutes'
       AND i.revoked_at IS NULL AND i.expires_at > now() AND c.blocked_at IS NULL) THEN
    RAISE EXCEPTION 'message_family_access_live: an access is recorded only for an active session of a live invitation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_family_access_guard"
  BEFORE INSERT ON "message_family_access"
  FOR EACH ROW EXECUTE FUNCTION message_family_access_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads and inserts; only the lifecycle columns update; the access trail never updates.
ALTER TABLE "message_family_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_contact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_family_access" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_family_setting_org_isolation" ON "message_family_setting"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_contact_org_isolation" ON "message_family_contact"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_invitation_org_isolation" ON "message_family_invitation"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_session_org_isolation" ON "message_family_session"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_access_org_isolation" ON "message_family_access"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_family_setting" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("agency_name", "agency_phone", "bereavement_phone", "updated_by", "updated_at") ON "message_family_setting" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_family_contact" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("channel_id", "mode", "mode_changed_at", "closed_at", "closed_by", "blocked_at", "blocked_by", "last_contact_message_at", "last_staff_reply_at", "staff_seen_through") ON "message_family_contact" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_family_invitation" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by", "revoke_reason", "invite_redeemed_at", "code_attempts") ON "message_family_invitation" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_family_session" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("stage", "activated_at", "token_hash", "last_seen_at") ON "message_family_session" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_family_access" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern, one function for the five tables. The patient and caregiver ids are scrubbed and the three hashes omitted; a
-- session's last-seen touch is not an audit event. Ids, instants and counts only: no message text exists in any of these tables.
CREATE OR REPLACE FUNCTION audit_phi_write_message_family() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'message_family_session' AND (to_jsonb(NEW) - 'last_seen_at') = (to_jsonb(OLD) - 'last_seen_at') THEN
    RETURN NEW;
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'invite_token_hash' - 'code_hash' - 'token_hash', ARRAY['patient_id','patient_caregiver_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'invite_token_hash' - 'code_hash' - 'token_hash', ARRAY['patient_id','patient_caregiver_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
    COALESCE(to_jsonb(NEW) ->> 'id', to_jsonb(OLD) ->> 'id', to_jsonb(NEW) ->> 'organization_id', to_jsonb(OLD) ->> 'organization_id')::uuid,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', (CASE WHEN TG_TABLE_NAME IN ('message_family_contact','message_family_invitation') THEN 'warn' ELSE 'info' END)::audit_severity,
    v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_family() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_family_setting"
  AFTER INSERT OR UPDATE OR DELETE ON message_family_setting
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_family();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_family_contact"
  AFTER INSERT OR UPDATE OR DELETE ON message_family_contact
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_family();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_family_invitation"
  AFTER INSERT OR UPDATE OR DELETE ON message_family_invitation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_family();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_family_session"
  AFTER INSERT OR UPDATE OR DELETE ON message_family_session
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_family();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_family_access"
  AFTER INSERT OR UPDATE OR DELETE ON message_family_access
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_family();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_family_setting" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_family_contact" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_family_invitation" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_family_session" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_family_access" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "message_family_setting_destruction" ON "message_family_setting"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_contact_destruction" ON "message_family_contact"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_invitation_destruction" ON "message_family_invitation"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_session_destruction" ON "message_family_session"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_family_access_destruction" ON "message_family_access"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The two permissions (mirrors 1180). PROVISIONAL until the clinical lead confirms the role set (ADR-0099 D9, DECISION NEEDED): manage goes to the
-- supervisor / social work / bereavement coordinator / compliance roles (plus the two full-catalog admin roles, as every catalog key does), respond
-- to the care-team disciplines as well. A role key a tenant does not have simply matches no row.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.family.manage', 'message_family_contact', 'manage', 'compliance', 'none', ''),
  ('messaging.family.respond', 'message_family_contact', 'respond', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('messaging.family.manage'), ('messaging.family.respond')) AS p("key")
 WHERE r."key" IN ('clinical_supervisor', 'msw', 'bereavement_coordinator', 'compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.family.respond'
  FROM "role" r
 WHERE r."key" IN ('rn', 'rn_case_manager', 'lpn', 'np', 'md', 'hospice_physician', 'medical_director', 'director_of_nursing', 'chaplain', 'bereavement_counselor')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
