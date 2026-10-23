-- M36 WP 6.6 (ADR-0096, PROPOSED), slice S1 - external partner share: an explicit, expiring (7 d default, 30 d max), read-only,
-- single-conversation grant for a non-workforce partner (pharmacy / DME), plus the staged partner session and an insert-only read trail.
-- The tenant flag messaging.external_partners (absent = off) gates creating a share and EVERY partner route; listing and revoking never
-- depend on it.
--   * message_external_share: one channel (composite FK), who created it (= app.user_id, CHECKed by the guard), the partner's label and kind,
--     the BAA reference the creator attests, shared_from (database clock, frozen: the partner never sees earlier messages), expires_at (frozen,
--     at most 30 days after shared_from), revoked_at/by (once), the invite token and code as HASHES only, invite_redeemed_at (once) and
--     code_attempts (0..5, +1 at a time, never reset). access is fixed to 'read'. A guard trigger freezes every other column.
--   * message_external_session: the partner's bearer session (hash only): enrolment -> active (forward only), never past the share's expiry.
--   * message_external_share_read: one insert-only row per partner read. Its guard refuses the row unless the session is ACTIVE and the share
--     is neither revoked nor expired NOW, so a read that cannot be recorded (or that follows a revoke) is refused by the database as well.
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS.
CREATE TABLE "message_external_share" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "user"("id"),
  "partner_name" text NOT NULL,
  "partner_kind" text NOT NULL,
  "access" text DEFAULT 'read' NOT NULL,
  "baa_reference" text NOT NULL,
  "shared_from" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by" uuid REFERENCES "user"("id"),
  "invite_token_hash" text NOT NULL,
  "invite_redeemed_at" timestamptz,
  "code_hash" text NOT NULL,
  "code_attempts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "message_external_share_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_external_share_invite_unique" UNIQUE ("invite_token_hash"),
  CONSTRAINT "message_external_share_kind" CHECK ("partner_kind" IN ('pharmacy', 'dme', 'other')),
  CONSTRAINT "message_external_share_access" CHECK ("access" = 'read'),
  CONSTRAINT "message_external_share_name_len" CHECK (char_length(btrim("partner_name")) BETWEEN 1 AND 120),
  CONSTRAINT "message_external_share_baa_len" CHECK (char_length(btrim("baa_reference")) BETWEEN 1 AND 120),
  CONSTRAINT "message_external_share_expiry" CHECK ("expires_at" > "shared_from" AND "expires_at" <= "shared_from" + interval '30 days'),
  CONSTRAINT "message_external_share_revoke_pair" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL)),
  CONSTRAINT "message_external_share_attempts" CHECK ("code_attempts" BETWEEN 0 AND 5),
  CONSTRAINT "message_external_share_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_external_share_channel_idx" ON "message_external_share" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_external_share_live_idx" ON "message_external_share" ("organization_id", "expires_at") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_external_share_created_by_idx" ON "message_external_share" ("created_by", "created_at");--> statement-breakpoint
CREATE INDEX "message_external_share_revoked_by_idx" ON "message_external_share" ("revoked_by") WHERE "revoked_by" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_external_share_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_external_share_actor: a share is recorded only by its creator' USING ERRCODE = 'check_violation';
    END IF;
    NEW.shared_from := now();
    NEW.created_at := now();
    NEW.revoked_at := NULL; NEW.revoked_by := NULL; NEW.invite_redeemed_at := NULL; NEW.code_attempts := 0;
    RETURN NEW;
  END IF;
  -- Everything except the three lifecycle facts is frozen for good (channel, partner, expiry, shared_from, hashes).
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','invite_redeemed_at','code_attempts'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','invite_redeemed_at','code_attempts']) THEN
    RAISE EXCEPTION 'message_external_share_immutable: only revoke, redemption and the attempt counter change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'message_external_share_revoke: a share is revoked once, by the acting user' USING ERRCODE = 'check_violation';
    END IF;
    NEW.revoked_at := now();
  END IF;
  IF NEW.invite_redeemed_at IS DISTINCT FROM OLD.invite_redeemed_at THEN
    IF OLD.invite_redeemed_at IS NOT NULL THEN
      RAISE EXCEPTION 'message_external_share_redeemed: the invitation is single use' USING ERRCODE = 'check_violation';
    END IF;
    NEW.invite_redeemed_at := now();
  END IF;
  IF NEW.code_attempts IS DISTINCT FROM OLD.code_attempts AND NEW.code_attempts <> OLD.code_attempts + 1 THEN
    RAISE EXCEPTION 'message_external_share_attempts: the counter only goes up by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_external_share_guard"
  BEFORE INSERT OR UPDATE ON "message_external_share"
  FOR EACH ROW EXECUTE FUNCTION message_external_share_guard();--> statement-breakpoint

CREATE TABLE "message_external_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "share_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "stage" text DEFAULT 'enrolment' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "activated_at" timestamptz,
  CONSTRAINT "message_external_session_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_external_session_token_unique" UNIQUE ("token_hash"),
  CONSTRAINT "message_external_session_stage" CHECK ("stage" IN ('enrolment', 'active')),
  CONSTRAINT "message_external_session_stage_pair" CHECK (("stage" = 'active') = ("activated_at" IS NOT NULL)),
  CONSTRAINT "message_external_session_share_fk"
    FOREIGN KEY ("organization_id", "share_id")
    REFERENCES "message_external_share"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_external_session_share_idx" ON "message_external_session" ("organization_id", "share_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_external_session_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.stage := 'enrolment'; NEW.activated_at := NULL; NEW.created_at := now();
    -- Born only against a live, redeemed share, and never outliving it.
    IF NOT EXISTS (
      SELECT 1 FROM message_external_share s
       WHERE s.organization_id = NEW.organization_id AND s.id = NEW.share_id
         AND s.revoked_at IS NULL AND s.expires_at > now() AND s.invite_redeemed_at IS NOT NULL
         AND NEW.expires_at <= s.expires_at AND NEW.expires_at > now()) THEN
      RAISE EXCEPTION 'message_external_session_share: a session needs a live, redeemed share and cannot outlive it' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['stage','activated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['stage','activated_at']) THEN
    RAISE EXCEPTION 'message_external_session_immutable: only the stage changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.stage = 'enrolment' AND NEW.stage = 'active') THEN
    RAISE EXCEPTION 'message_external_session_stage: enrolment -> active, once' USING ERRCODE = 'check_violation';
  END IF;
  NEW.activated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_external_session_guard"
  BEFORE INSERT OR UPDATE ON "message_external_session"
  FOR EACH ROW EXECUTE FUNCTION message_external_session_guard();--> statement-breakpoint

CREATE TABLE "message_external_share_read" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "share_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "read_at" timestamptz DEFAULT now() NOT NULL,
  "message_count" integer NOT NULL,
  CONSTRAINT "message_external_share_read_count" CHECK ("message_count" >= 0),
  CONSTRAINT "message_external_share_read_share_fk"
    FOREIGN KEY ("organization_id", "share_id")
    REFERENCES "message_external_share"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_external_share_read_session_fk"
    FOREIGN KEY ("organization_id", "session_id")
    REFERENCES "message_external_session"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_external_share_read_share_idx" ON "message_external_share_read" ("organization_id", "share_id", "read_at");--> statement-breakpoint
CREATE INDEX "message_external_share_read_session_idx" ON "message_external_share_read" ("organization_id", "session_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_external_share_read_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.read_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM message_external_session x
      JOIN message_external_share s ON s.organization_id = x.organization_id AND s.id = x.share_id
     WHERE x.organization_id = NEW.organization_id AND x.id = NEW.session_id AND s.id = NEW.share_id
       AND x.stage = 'active' AND x.expires_at > now()
       AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
    RAISE EXCEPTION 'message_external_share_read_live: a read is recorded only for an active session of a live share' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_external_share_read_guard"
  BEFORE INSERT ON "message_external_share_read"
  FOR EACH ROW EXECUTE FUNCTION message_external_share_read_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads and inserts; only the lifecycle columns update; the read trail never updates.
ALTER TABLE "message_external_share" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_external_share" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_external_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_external_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_external_share_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_external_share_read" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_external_share_org_isolation" ON "message_external_share"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_external_session_org_isolation" ON "message_external_session"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_external_share_read_org_isolation" ON "message_external_share_read"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_external_share" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by", "invite_redeemed_at", "code_attempts") ON "message_external_share" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_external_session" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("stage", "activated_at") ON "message_external_session" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_external_share_read" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern. The share audit row omits the two hashes, the BAA reference and the partner label; the session row omits its hash.
CREATE OR REPLACE FUNCTION audit_phi_write_message_external_share() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'invite_token_hash' - 'code_hash' - 'baa_reference' - 'partner_name', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'invite_token_hash' - 'code_hash' - 'baa_reference' - 'partner_name', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_external_share.' || lower(TG_OP), 'message_external_share',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'warn', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_external_share() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_external_share"
  AFTER INSERT OR UPDATE OR DELETE ON message_external_share
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_external_share();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_external_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'token_hash', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'token_hash', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_external_session.' || lower(TG_OP), 'message_external_session',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_external_session() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_external_session"
  AFTER INSERT OR UPDATE OR DELETE ON message_external_session
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_external_session();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_external_share_read() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_external_share_read.' || lower(TG_OP), 'message_external_share_read',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_external_share_read() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_external_share_read"
  AFTER INSERT OR UPDATE OR DELETE ON message_external_share_read
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_external_share_read();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_external_share" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_external_session" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_external_share_read" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "message_external_share_destruction" ON "message_external_share"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_external_session_destruction" ON "message_external_session"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_external_share_read_destruction" ON "message_external_share_read"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permission (mirrors 1147). Create and revoke also demand a fresh step-up in the route. PROVISIONAL until compliance confirms the role
-- set (ADR-0096 open items). No clinical, aide or other default role holds it.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.share.manage', 'message_external_share', 'manage', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.share.manage'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
