-- M25 milestone 9a-1 (hospice ADR/TPE/QIC PRD, milestone 9): the denial-reason PLAYBOOK library. Org-authored guidance for one
-- denial reason (a code kind + code, optionally one MAC): a short summary and an ordered list of steps, shown beside a
-- denial and its appeals. Three tables:
--
--   denial_playbook            the key (code kind + code + optional MAC) and a title. Immutable: no UPDATE grant.
--   denial_playbook_version    one row per authored version. draft -> published -> retired, forward only. Content is frozen
--                              once published (trigger); a published row carries a reviewer who is NOT its author (CHECK);
--                              at most one published and one draft per playbook (partial unique indexes). source_note is
--                              mandatory and non-blank: guidance without a source is never saved.
--   denial_playbook_case_step  an advisory per-denial tick of one step. No free text. NOTHING reads it: it gates no state.
--
-- NO GUIDANCE TEXT IS SEEDED and there is no platform playbook: a fresh tenant has zero rows in all three tables, and a
-- denial with no published playbook shows "not written yet". Nothing here states a CMS, MAC or payer rule. A playbook never
-- changes routing, deadlines, checklist state, sign-off, filing or any case row; this migration adds no column to any
-- existing table. Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK
-- mirrored in domain/playbook.ts, so there is no new pgEnum. Idempotent on purpose (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "denial_playbook" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mac_name" text CHECK ("mac_name" IS NULL OR btrim("mac_name") <> ''),
  "code_kind" text NOT NULL CHECK ("code_kind" IN ('mac_reason','rarc','carc')),
  "code" varchar(16) NOT NULL CHECK (btrim("code") <> ''),
  "title" text NOT NULL CHECK (btrim("title") <> '' AND char_length("title") <= 120),
  "created_by_membership_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- MAC names and codes match case-insensitively (the denial_route_rule_key shape), so the key must too (a null MAC = every MAC).
CREATE UNIQUE INDEX IF NOT EXISTS "denial_playbook_key" ON "denial_playbook"
  ("organization_id", lower(btrim(coalesce("mac_name", ''))), "code_kind", upper(btrim("code")));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "denial_playbook_org_ix" ON "denial_playbook" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "denial_playbook_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "playbook_id" uuid NOT NULL REFERENCES "denial_playbook"("id") ON DELETE RESTRICT,
  "version_no" integer NOT NULL CHECK ("version_no" >= 1),
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','published','retired')),
  "summary" text NOT NULL CHECK (btrim("summary") <> '' AND char_length("summary") <= 1000),
  -- [{ "key": "...", "text": "..." }]: shape validated in domain/playbook.ts; the database pins the envelope and the count.
  "steps" jsonb NOT NULL CHECK (jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") BETWEEN 1 AND 30),
  "source_note" text NOT NULL CHECK (btrim("source_note") <> '' AND char_length("source_note") <= 500),
  -- Logical FK to an M22 document (the source the author used); not enforced here.
  "source_document_id" uuid,
  "authored_by_membership_id" uuid NOT NULL,
  -- Whoever last changed the content: the author at creation, then anyone who edits the draft. A reviewer must be neither
  -- the author nor the last editor, so a second person cannot rewrite a draft and then approve their own words.
  "last_edited_by_membership_id" uuid NOT NULL,
  -- The same three facts by USER id: a revoked and re-invited person gets a NEW membership id, so membership ids alone would
  -- let one human approve their own work. Residual risk: two accounts held by one person cannot be told apart here.
  "authored_by_user_id" uuid NOT NULL,
  "last_edited_by_user_id" uuid NOT NULL,
  "reviewed_by_user_id" uuid,
  "reviewed_by_membership_id" uuid,
  "published_at" timestamptz,
  "retired_at" timestamptz,
  "effective_from" date,
  "row_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "denial_playbook_version_no_key" UNIQUE ("playbook_id", "version_no"),
  -- A draft carries no review; a published or retired version carries its reviewer, who is not its author, and its date.
  CONSTRAINT "denial_playbook_version_draft_unreviewed" CHECK ("status" <> 'draft'
    OR ("reviewed_by_membership_id" IS NULL AND "reviewed_by_user_id" IS NULL AND "published_at" IS NULL AND "effective_from" IS NULL AND "retired_at" IS NULL)),
  CONSTRAINT "denial_playbook_version_published_reviewed" CHECK ("status" = 'draft'
    OR ("reviewed_by_membership_id" IS NOT NULL AND "reviewed_by_membership_id" <> "authored_by_membership_id"
        AND "reviewed_by_membership_id" <> "last_edited_by_membership_id"
        AND "reviewed_by_user_id" IS NOT NULL AND "reviewed_by_user_id" <> "authored_by_user_id"
        AND "reviewed_by_user_id" <> "last_edited_by_user_id"
        AND "published_at" IS NOT NULL AND "effective_from" IS NOT NULL)),
  CONSTRAINT "denial_playbook_version_retired_has_time" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "denial_playbook_version_one_published" ON "denial_playbook_version" ("playbook_id") WHERE "status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "denial_playbook_version_one_draft" ON "denial_playbook_version" ("playbook_id") WHERE "status" = 'draft';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "denial_playbook_version_org_ix" ON "denial_playbook_version" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "denial_playbook_case_step" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "denial_case_id" uuid NOT NULL REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "playbook_version_id" uuid NOT NULL REFERENCES "denial_playbook_version"("id") ON DELETE RESTRICT,
  "step_key" text NOT NULL CHECK (btrim("step_key") <> ''),
  -- 'open' undoes a tick without a DELETE (the app role has none and the audit trail keeps every change).
  "status" text NOT NULL CHECK ("status" IN ('open','done','not_applicable')),
  "marked_by_membership_id" uuid NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "denial_playbook_case_step_key" UNIQUE ("denial_case_id", "playbook_version_id", "step_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "denial_playbook_case_step_version_ix" ON "denial_playbook_case_step" ("playbook_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "denial_playbook_case_step_org_ix" ON "denial_playbook_case_step" ("organization_id", "marked_at");--> statement-breakpoint
-- The unique key leads with denial_case_id, so it covers that foreign key; playbook_version_id has the index above. The
-- version table's (playbook_id, version_no) unique key covers its playbook_id foreign key.

-- RLS: the canonical single-shape org policy, FORCEd; the app role has no DELETE on any of the three.
ALTER TABLE "denial_playbook" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "denial_playbook" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "denial_playbook_org" ON "denial_playbook";--> statement-breakpoint
CREATE POLICY "denial_playbook_org" ON "denial_playbook" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "denial_playbook_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "denial_playbook_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "denial_playbook_version_org" ON "denial_playbook_version";--> statement-breakpoint
CREATE POLICY "denial_playbook_version_org" ON "denial_playbook_version" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "denial_playbook_case_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "denial_playbook_case_step" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "denial_playbook_case_step_org" ON "denial_playbook_case_step";--> statement-breakpoint
CREATE POLICY "denial_playbook_case_step_org" ON "denial_playbook_case_step" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- A playbook's key and title never change (a different key is a different playbook). A version's content is editable only
-- while a draft; the guard trigger below freezes it, and these column grants keep the anchor (playbook, number, author) fixed.
GRANT SELECT, INSERT ON "denial_playbook" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "denial_playbook" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "denial_playbook_version" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "summary", "steps", "source_note", "source_document_id", "last_edited_by_membership_id", "last_edited_by_user_id", "reviewed_by_membership_id", "reviewed_by_user_id",
  "published_at", "retired_at", "effective_from", "row_version") ON "denial_playbook_version" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "denial_playbook_version" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "denial_playbook_case_step" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "marked_by_membership_id", "marked_at") ON "denial_playbook_case_step" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "denial_playbook_case_step" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The playbook text and its source note are free text: scrubbed. The steps
-- are free text too.
CREATE OR REPLACE FUNCTION audit_phi_write_denial_playbook() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['title'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_playbook.' || lower(TG_OP), 'denial_playbook', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_playbook() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_denial_playbook" ON denial_playbook;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_playbook" AFTER INSERT OR UPDATE OR DELETE ON denial_playbook FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_playbook();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_denial_playbook_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['summary','steps','source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_playbook_version.' || lower(TG_OP), 'denial_playbook_version', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_playbook_version() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_denial_playbook_version" ON denial_playbook_version;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_playbook_version" AFTER INSERT OR UPDATE OR DELETE ON denial_playbook_version FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_playbook_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_denial_playbook_case_step() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_playbook_case_step.' || lower(TG_OP), 'denial_playbook_case_step', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_playbook_case_step() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_denial_playbook_case_step" ON denial_playbook_case_step;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_playbook_case_step" AFTER INSERT OR UPDATE OR DELETE ON denial_playbook_case_step FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_playbook_case_step();--> statement-breakpoint

-- Org-consistency: a FK does not prove the parent belongs to organization_id, and RLS hides another tenant's parent from
-- these SELECTs, so a cross-tenant playbook_id / denial_case_id / playbook_version_id fails closed.
CREATE OR REPLACE FUNCTION m25_denial_playbook_version_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_NEW_MUST_BE_DRAFT: a playbook version is created as a draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM denial_playbook WHERE id = NEW.playbook_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_PARENT: playbook % is not visible to this organization', NEW.playbook_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_denial_playbook_version_insert_guard" ON denial_playbook_version;--> statement-breakpoint
CREATE TRIGGER "trg_denial_playbook_version_insert_guard" BEFORE INSERT ON denial_playbook_version FOR EACH ROW EXECUTE FUNCTION m25_denial_playbook_version_insert_guard();--> statement-breakpoint

-- What was published is frozen: once a version leaves draft, its content, source and reviewer cannot change (a correction is
-- a new version, not an edit), the only legal edges are draft -> published and published -> retired, and a retired version
-- is terminal. SQL that bypasses the service cannot rewrite published guidance or move a version backwards.
CREATE OR REPLACE FUNCTION m25_denial_playbook_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_RETIRED_IMMUTABLE: playbook version % is retired and cannot be modified', OLD.id;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'published')
    OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_ILLEGAL_TRANSITION: playbook version % cannot move from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published' AND (
       NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.steps IS DISTINCT FROM OLD.steps
    OR NEW.source_note IS DISTINCT FROM OLD.source_note
    OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
    OR NEW.last_edited_by_membership_id IS DISTINCT FROM OLD.last_edited_by_membership_id
    OR NEW.last_edited_by_user_id IS DISTINCT FROM OLD.last_edited_by_user_id) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_PUBLISH_CONTENT: playbook version % may not change content or last editor while being published', OLD.id;
  END IF;
  IF OLD.status = 'published' AND (
       NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.steps IS DISTINCT FROM OLD.steps
    OR NEW.source_note IS DISTINCT FROM OLD.source_note
    OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
    OR NEW.last_edited_by_membership_id IS DISTINCT FROM OLD.last_edited_by_membership_id
    OR NEW.last_edited_by_user_id IS DISTINCT FROM OLD.last_edited_by_user_id
    OR NEW.reviewed_by_membership_id IS DISTINCT FROM OLD.reviewed_by_membership_id
    OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_PUBLISHED_IMMUTABLE: playbook version % is published; its content cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_denial_playbook_version_guard" ON denial_playbook_version;--> statement-breakpoint
CREATE TRIGGER "trg_denial_playbook_version_guard" BEFORE UPDATE ON denial_playbook_version FOR EACH ROW EXECUTE FUNCTION m25_denial_playbook_version_guard();--> statement-breakpoint

-- A tick must name a denial and a PUBLISHED version of this organization, and a step that version actually has.
CREATE OR REPLACE FUNCTION m25_denial_playbook_case_step_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM denial_case WHERE id = NEW.denial_case_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_PARENT: denial case % is not visible to this organization', NEW.denial_case_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM denial_playbook_version v, jsonb_array_elements(v.steps) AS s
     WHERE v.id = NEW.playbook_version_id AND v.organization_id = NEW.organization_id AND v.status = 'published'
       AND s ->> 'key' = NEW.step_key) THEN
    RAISE EXCEPTION 'M25_PLAYBOOK_STEP: version % is not published or has no step %', NEW.playbook_version_id, NEW.step_key;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_denial_playbook_case_step_guard" ON denial_playbook_case_step;--> statement-breakpoint
CREATE TRIGGER "trg_denial_playbook_case_step_guard" BEFORE INSERT ON denial_playbook_case_step FOR EACH ROW EXECUTE FUNCTION m25_denial_playbook_case_step_guard();--> statement-breakpoint

-- playbook.read: see the library and a denial's playbook. playbook.author: write a playbook and its drafts. playbook.publish:
-- publish a draft someone else wrote, or retire a published version. None gates a case, and the per-case tick needs only
-- playbook.step.mark and denial.read. Existing tenants' roles get them from 1251.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('playbook.read', 'denial_playbook', 'read', 'billing', 'none', 'See the organization''s denial playbooks and the playbook that applies to a denial'),
  ('playbook.author', 'denial_playbook', 'author', 'billing', 'none', 'Write a denial playbook and its draft versions'),
  ('playbook.publish', 'denial_playbook', 'publish', 'billing', 'none', 'Publish a draft playbook that someone else wrote, or retire a published version'),
  ('playbook.step.mark', 'denial_playbook', 'step_mark', 'billing', 'provider_entity_scope', 'Tick or reset a playbook step on a denial (advisory; gates nothing)')
ON CONFLICT ("key") DO NOTHING;
