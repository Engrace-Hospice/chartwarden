-- M36 WP 5.8 (ADR-0087, PROPOSED), slice S1 - messaging break-glass: a self-requested, time-limited, read-only grant on ONE channel, always
-- followed by a compliance review. Schema, guards and permissions only: NOTHING writes or reads these tables until S2/S3, and the tenant
-- flag messaging.break_glass (absent = off) gates the wiring.
--   * message_break_glass_grant: who may read which channel until when, why (closed reason code + 20..280 char justification, reviewer-only
--     text), and when it was ended early. Expiry is the DATABASE clock: granted_at is forced to now() on insert, revoked_at to now() on
--     revoke, and every check compares to now() in SQL. expires_at > granted_at and expires_at <= granted_at + 24 hours are CHECKs (D2;
--     the 4 hour default is the service's). Insert / revoke-only: the one permitted update moves revoked_at NULL -> a value, once; the app
--     role holds no DELETE (only chartwarden_destruction deletes). One un-revoked grant per (channel, grantee); an expired but unrevoked
--     grant still occupies that slot, so the service revokes it before re-granting (renewal is a new request, never an extension).
--   * message_break_glass_review: the mandatory post-review (D1). A grant without one cannot commit (deferred constraint trigger). Created
--     pending; completed ONCE by a reviewer who is not the grantee (guard), after the grant has ended, with outcome reviewed|concern
--     (a concern needs a note). The deadline (D5) is NOT stored: it derives from the grant end and a named constant in the service.
--   * message_break_glass_read: one insert-only row per read under a grant (ids, kind, count, instant - never a body). Its guard refuses a
--     row unless the grant is live NOW and belongs to the acting user, so a read that cannot be recorded is refused (D10) and nobody
--     records reads for someone else's grant. The review screen lists these.
--   * Every guard is SECURITY INVOKER: its reads of the grant run under the caller's own org RLS, so another organization's grant is
--     invisible and a cross-org probe fails like a row that does not exist.
CREATE TABLE "message_break_glass_grant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "grantee_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "reason_code" text NOT NULL,
  "justification" text NOT NULL,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "message_break_glass_grant_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_break_glass_grant_reason" CHECK ("reason_code" IN ('patient_safety', 'covering_colleague', 'record_correction', 'other')),
  CONSTRAINT "message_break_glass_grant_justification" CHECK (char_length(btrim("justification")) BETWEEN 20 AND 280),
  CONSTRAINT "message_break_glass_grant_window" CHECK ("expires_at" > "granted_at"),
  CONSTRAINT "message_break_glass_grant_max_window" CHECK ("expires_at" <= "granted_at" + interval '24 hours'),
  CONSTRAINT "message_break_glass_grant_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX "message_break_glass_grant_one_open"
  ON "message_break_glass_grant" ("organization_id", "channel_id", "grantee_user_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_break_glass_grant_grantee_idx"
  ON "message_break_glass_grant" ("organization_id", "grantee_user_id", "expires_at");--> statement-breakpoint
CREATE INDEX "message_break_glass_grant_channel_idx"
  ON "message_break_glass_grant" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_break_glass_grant_grantee_user_idx" ON "message_break_glass_grant" ("grantee_user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_break_glass_grant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.granted_at := now();
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_break_glass_grant_revoked: a revoked grant cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL OR (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'message_break_glass_grant_immutable: the only change allowed is ending the grant' USING ERRCODE = 'check_violation';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_break_glass_grant_guard"
  BEFORE INSERT OR UPDATE ON "message_break_glass_grant"
  FOR EACH ROW EXECUTE FUNCTION message_break_glass_grant_guard();--> statement-breakpoint

CREATE TABLE "message_break_glass_review" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "grant_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "reviewer_user_id" uuid REFERENCES "user"("id"),
  "reviewed_at" timestamptz,
  "outcome" text,
  "note" text,
  CONSTRAINT "message_break_glass_review_grant_unique" UNIQUE ("organization_id", "grant_id"),
  CONSTRAINT "message_break_glass_review_grant_fk"
    FOREIGN KEY ("organization_id", "grant_id")
    REFERENCES "message_break_glass_grant"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_break_glass_review_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('reviewed', 'concern')),
  CONSTRAINT "message_break_glass_review_state" CHECK (
    ("reviewed_at" IS NULL AND "reviewer_user_id" IS NULL AND "outcome" IS NULL AND "note" IS NULL)
    OR ("reviewed_at" IS NOT NULL AND "reviewer_user_id" IS NOT NULL AND "outcome" IS NOT NULL)),
  CONSTRAINT "message_break_glass_review_concern_note" CHECK ("outcome" IS DISTINCT FROM 'concern' OR coalesce(char_length(btrim("note")), 0) > 0),
  CONSTRAINT "message_break_glass_review_note_len" CHECK ("note" IS NULL OR char_length("note") <= 1000)
);--> statement-breakpoint
CREATE INDEX "message_break_glass_review_pending_idx"
  ON "message_break_glass_review" ("organization_id", "created_at") WHERE "reviewed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_break_glass_review_reviewer_idx" ON "message_break_glass_review" ("reviewer_user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_break_glass_review_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_grantee uuid; v_ended boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.reviewer_user_id := NULL; NEW.reviewed_at := NULL; NEW.outcome := NULL; NEW.note := NULL;
    RETURN NEW;
  END IF;
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_break_glass_review_done: a completed review cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'reviewer_user_id' - 'reviewed_at' - 'outcome' - 'note')
     IS DISTINCT FROM (to_jsonb(OLD) - 'reviewer_user_id' - 'reviewed_at' - 'outcome' - 'note') THEN
    RAISE EXCEPTION 'message_break_glass_review_immutable: only the reviewer, outcome and note are set' USING ERRCODE = 'check_violation';
  END IF;
  SELECT g.grantee_user_id, (g.revoked_at IS NOT NULL OR g.expires_at <= now()) INTO v_grantee, v_ended
    FROM message_break_glass_grant g WHERE g.organization_id = NEW.organization_id AND g.id = NEW.grant_id;
  IF NEW.reviewer_user_id IS NOT DISTINCT FROM v_grantee THEN
    RAISE EXCEPTION 'message_break_glass_review_self: the reviewer is not the person who held the grant' USING ERRCODE = 'check_violation';
  END IF;
  IF v_ended IS NOT TRUE THEN
    RAISE EXCEPTION 'message_break_glass_review_open: the grant has not ended' USING ERRCODE = 'check_violation';
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_break_glass_review_guard"
  BEFORE INSERT OR UPDATE ON "message_break_glass_review"
  FOR EACH ROW EXECUTE FUNCTION message_break_glass_review_guard();--> statement-breakpoint

-- D1: a grant cannot commit without its review row (the service inserts both in one transaction).
CREATE OR REPLACE FUNCTION message_break_glass_grant_has_review() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM message_break_glass_review r WHERE r.organization_id = NEW.organization_id AND r.grant_id = NEW.id) THEN
    RAISE EXCEPTION 'message_break_glass_grant_unreviewed: a grant is created with its review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "trg_message_break_glass_grant_has_review"
  AFTER INSERT ON "message_break_glass_grant"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION message_break_glass_grant_has_review();--> statement-breakpoint

CREATE TABLE "message_break_glass_read" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "grant_id" uuid NOT NULL,
  "read_kind" text NOT NULL,
  "resource_id" uuid,
  "item_count" integer,
  "read_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_break_glass_read_grant_fk"
    FOREIGN KEY ("organization_id", "grant_id")
    REFERENCES "message_break_glass_grant"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_break_glass_read_kind" CHECK ("read_kind" IN ('channel', 'messages', 'thread', 'attachment', 'search', 'ack', 'handoff', 'context')),
  CONSTRAINT "message_break_glass_read_count" CHECK ("item_count" IS NULL OR "item_count" >= 0)
);--> statement-breakpoint
CREATE INDEX "message_break_glass_read_grant_idx" ON "message_break_glass_read" ("organization_id", "grant_id", "read_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_break_glass_read_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.read_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM message_break_glass_grant g
     WHERE g.organization_id = NEW.organization_id AND g.id = NEW.grant_id
       AND g.revoked_at IS NULL AND g.expires_at > now()
       AND g.grantee_user_id = nullif(current_setting('app.user_id', true), '')::uuid) THEN
    RAISE EXCEPTION 'message_break_glass_read_grant: a read is recorded only against a live grant held by the reader' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_break_glass_read_guard"
  BEFORE INSERT ON "message_break_glass_read"
  FOR EACH ROW EXECUTE FUNCTION message_break_glass_read_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd), the app role insert/read (grant: revoke only; review: complete only), destruction by privilege.
ALTER TABLE "message_break_glass_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_break_glass_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_break_glass_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_break_glass_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_break_glass_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_break_glass_read" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_break_glass_grant_org_isolation" ON "message_break_glass_grant"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_break_glass_review_org_isolation" ON "message_break_glass_review"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_break_glass_read_org_isolation" ON "message_break_glass_read"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_break_glass_grant" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at") ON "message_break_glass_grant" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_break_glass_review" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("reviewer_user_id", "reviewed_at", "outcome", "note") ON "message_break_glass_review" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_break_glass_read" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern for the two tables a person writes (the grant and its review); no patient column, so the scrub list is empty.
-- The free text (justification, note) is left out of the audit row: it is reviewer-only. The read table is also audited (the arch:gaps rule
-- for every org-scoped table); its own rows remain the queryable trail the review screen lists.
CREATE OR REPLACE FUNCTION audit_phi_write_message_break_glass_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'justification', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'justification', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_break_glass_grant.' || lower(TG_OP), 'message_break_glass_grant',
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
ALTER FUNCTION audit_phi_write_message_break_glass_grant() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_break_glass_grant"
  AFTER INSERT OR UPDATE OR DELETE ON message_break_glass_grant
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_break_glass_grant();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_break_glass_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'note', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'note', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_break_glass_review.' || lower(TG_OP), 'message_break_glass_review',
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
ALTER FUNCTION audit_phi_write_message_break_glass_review() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_break_glass_review"
  AFTER INSERT OR UPDATE OR DELETE ON message_break_glass_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_break_glass_review();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_break_glass_read() RETURNS trigger
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
    'message_break_glass_read.' || lower(TG_OP), 'message_break_glass_read',
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
ALTER FUNCTION audit_phi_write_message_break_glass_read() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_break_glass_read"
  AFTER INSERT OR UPDATE OR DELETE ON message_break_glass_read
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_break_glass_read();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_break_glass_grant" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_break_glass_review" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_break_glass_read" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "message_break_glass_grant_destruction" ON "message_break_glass_grant"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_break_glass_review_destruction" ON "message_break_glass_review"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_break_glass_read_destruction" ON "message_break_glass_read"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permissions (mirrors 1129 / 1138). Invoking also demands a fresh step-up and a written justification in the route (S3). Invoke goes
-- to the qualified clinical roles of 1105's messaging.urgent.receive list plus the two admins; NOT lpn, msw, chaplain, aides or volunteers.
-- PROVISIONAL until the clinical lead confirms the role map (ADR-0087 open items). Review goes to compliance and the two admins; the
-- reviewer can never be the grantee (guard above + service).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.break_glass.invoke', 'message_break_glass', 'invoke', 'compliance', 'none', ''),
  ('messaging.break_glass.review', 'message_break_glass', 'review', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.break_glass.invoke'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin', 'rn', 'rn_case_manager', 'director_of_nursing', 'don', 'md', 'physician',
                   'hospice_physician', 'medical_director', 'attending_clinician', 'np', 'nurse_practitioner', 'pa',
                   'clinical_supervisor', 'clinical_lead')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.break_glass.review'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
