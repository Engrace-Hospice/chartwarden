-- M25 milestone 12a-1: the PAYER APPEAL CASE, one row per level of a commercial (or Medicare Advantage plan) payer's own
-- appeal path, linked by prior_level_case_id. Deliberately NOT appeal_case: that aggregate is the Medicare chain (its tier
-- enum, its NOT NULL tier_deadline_at, its 5-day presumption and holiday roll-back are Medicare rules), and a payer level
-- on that clock would be a contract level on the wrong rules.
--
--  * Subject is a denial_case (required). claim_id is copied when the denial has one and is NULL for a commercial denial:
--    no commercial claim record exists, so the 835 line never matched a claim.
--  * The case SNAPSHOTS the path revision and the level's window values it was opened under, so a later path edit never
--    moves a deadline (the mac_rule precedent, 1108). With no active path the case still opens: deadline_source = 'none'
--    and the person types a recorded_deadline from the notice (1208) or sees "No due date".
--  * deadline_at is computed only from a complete level window and an anchor date a person typed from the notice, and
--    window_verified records whether the path had been verified. Once set, the deadline never moves.
--  * `external_reviewer_name` exists only on an `external_review` level and is typed as the notice states it.
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/payer-appeal.ts. Frozen once closed or withdrawn. Free text is audit-scrubbed. Idempotent.

CREATE TABLE IF NOT EXISTS "payer_appeal_case" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "denial_case_id" uuid NOT NULL REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "claim_id" uuid, -- M23 logical FK; NULL for a commercial denial
  "payer_id" uuid NOT NULL, -- M40 logical FK, from the denial's remittance advice
  "program" text NOT NULL CHECK ("program" IN ('commercial','medicare_advantage')),
  -- The path revision and level this case was opened under (all NULL when no path was recorded for the payer).
  "path_id" uuid REFERENCES "payer_appeal_path"("id") ON DELETE RESTRICT,
  "path_revision" integer,
  "level_ordinal" integer,
  "level_kind" text NOT NULL CHECK ("level_kind" IN ('internal','external_review','other')),
  "level_label" text NOT NULL CHECK (btrim("level_label") <> ''),
  -- The level's filing window as it stood at opening (a snapshot; all NULL when the level recorded none).
  "window_days" integer,
  "anchor_kind" text,
  "receipt_presumption_days" integer,
  "day_basis" text,
  "roll" text,
  "decision_days" integer,
  "prior_level_case_id" uuid REFERENCES "payer_appeal_case"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft','submitted','under_review','decided','withdrawn','closed')),
  "notice_dated_on" date, -- the anchor date typed from the notice
  "deadline_at" timestamptz,
  "deadline_zone" text,
  "deadline_source" text NOT NULL DEFAULT 'none' CHECK ("deadline_source" IN ('path_rule','none')),
  "window_verified" boolean NOT NULL DEFAULT false,
  "payer_reference" text, -- audit-scrubbed
  "external_reviewer_name" text, -- audit-scrubbed
  "decision_outcome" text CHECK ("decision_outcome" IS NULL OR "decision_outcome" IN ('favorable','partial','unfavorable')),
  "disposition_kind" text CHECK ("disposition_kind" IS NULL OR "disposition_kind" IN ('decision','remand','dismissal','other')),
  "disposition_note" text, -- audit-scrubbed
  "submitted_at" timestamptz,
  "decided_at" timestamptz,
  "closed_at" timestamptz,
  "created_by_membership_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payer_appeal_case_path_triple" CHECK (("path_id" IS NULL) = ("path_revision" IS NULL) AND ("path_id" IS NULL) = ("level_ordinal" IS NULL)),
  CONSTRAINT "payer_appeal_case_deadline_matches_source" CHECK (("deadline_source" = 'path_rule') = ("deadline_at" IS NOT NULL AND "deadline_zone" IS NOT NULL AND "notice_dated_on" IS NOT NULL)),
  CONSTRAINT "payer_appeal_case_decided_has_outcome" CHECK ("state" <> 'decided' OR "decision_outcome" IS NOT NULL),
  CONSTRAINT "payer_appeal_case_reviewer_only_external" CHECK ("external_reviewer_name" IS NULL OR "level_kind" = 'external_review'),
  CONSTRAINT "payer_appeal_case_other_needs_note" CHECK ("disposition_kind" IS DISTINCT FROM 'other' OR ("disposition_note" IS NOT NULL AND btrim("disposition_note") <> '')),
  CONSTRAINT "payer_appeal_case_note_needs_kind" CHECK ("disposition_note" IS NULL OR "disposition_kind" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_denial" ON "payer_appeal_case" ("denial_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_claim" ON "payer_appeal_case" ("claim_id") WHERE "claim_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_path" ON "payer_appeal_case" ("path_id") WHERE "path_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_prior" ON "payer_appeal_case" ("prior_level_case_id") WHERE "prior_level_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_deadline" ON "payer_appeal_case" ("deadline_at") WHERE "state" = 'draft' AND "deadline_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_case_org_ix" ON "payer_appeal_case" ("organization_id", "created_at");--> statement-breakpoint
-- One level in flight per denial; the next level opens once this one is decided or closed.
CREATE UNIQUE INDEX IF NOT EXISTS "payer_appeal_one_in_flight" ON "payer_appeal_case" ("denial_case_id") WHERE "state" IN ('draft','submitted','under_review');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payer_appeal_case_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "payer_appeal_case_id" uuid NOT NULL REFERENCES "payer_appeal_case"("id") ON DELETE RESTRICT,
  "event_kind" text NOT NULL,
  "event_payload" jsonb,
  "actor_membership_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_payer_appeal_event_case" ON "payer_appeal_case_event" ("payer_appeal_case_id", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_case_event_org_ix" ON "payer_appeal_case_event" ("organization_id", "occurred_at");--> statement-breakpoint

ALTER TABLE "payer_appeal_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_appeal_case" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "payer_appeal_case_org" ON "payer_appeal_case";--> statement-breakpoint
CREATE POLICY "payer_appeal_case_org" ON "payer_appeal_case" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "payer_appeal_case_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_appeal_case_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "payer_appeal_case_event_org" ON "payer_appeal_case_event";--> statement-breakpoint
CREATE POLICY "payer_appeal_case_event_org" ON "payer_appeal_case_event" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Subject, payer, program and the path / level snapshot never change after insert; only progress columns are updatable.
-- The history is append-only for the app role: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON "payer_appeal_case" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("state", "notice_dated_on", "deadline_at", "deadline_zone", "deadline_source", "window_verified",
  "payer_reference", "external_reviewer_name", "decision_outcome", "disposition_kind", "disposition_note",
  "submitted_at", "decided_at", "closed_at", "version", "updated_at") ON "payer_appeal_case" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "payer_appeal_case" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "payer_appeal_case_event" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "payer_appeal_case_event" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). Payer reference, reviewer name and every note are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_payer_appeal_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['level_label','payer_reference','external_reviewer_name','disposition_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'payer_appeal_case.' || lower(TG_OP), 'payer_appeal_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payer_appeal_case() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_payer_appeal_case" ON payer_appeal_case;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payer_appeal_case" AFTER INSERT OR UPDATE OR DELETE ON payer_appeal_case FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payer_appeal_case();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_payer_appeal_case_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'payer_appeal_case_event.' || lower(TG_OP), 'payer_appeal_case_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payer_appeal_case_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_payer_appeal_case_event" ON payer_appeal_case_event;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payer_appeal_case_event" AFTER INSERT OR UPDATE OR DELETE ON payer_appeal_case_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payer_appeal_case_event();--> statement-breakpoint

-- Insert: the denial, the path and the prior level must be visible to this organization (RLS hides another tenant's rows,
-- so a cross-tenant id fails closed), and a prior level belongs to the same denial. Update: a closed or withdrawn case is
-- frozen, and a deadline, once set, never moves (a path edit or a late notice date cannot change it).
CREATE OR REPLACE FUNCTION m25_payer_appeal_case_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean; v_prior_denial uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT true INTO v_ok FROM denial_case WHERE id = NEW.denial_case_id AND organization_id = NEW.organization_id;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'M25_PAYER_APPEAL_PARENT: denial_case % is not visible to this organization', NEW.denial_case_id;
    END IF;
    IF NEW.path_id IS NOT NULL THEN
      v_ok := NULL;
      SELECT true INTO v_ok FROM payer_appeal_path WHERE id = NEW.path_id AND organization_id = NEW.organization_id;
      IF v_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'M25_PAYER_APPEAL_PATH: payer_appeal_path % is not visible to this organization', NEW.path_id;
      END IF;
    END IF;
    IF NEW.prior_level_case_id IS NOT NULL THEN
      SELECT denial_case_id INTO v_prior_denial FROM payer_appeal_case WHERE id = NEW.prior_level_case_id AND organization_id = NEW.organization_id;
      IF v_prior_denial IS DISTINCT FROM NEW.denial_case_id THEN
        RAISE EXCEPTION 'M25_PAYER_APPEAL_PRIOR: the prior level is not visible or belongs to another denial';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('closed','withdrawn') THEN
    RAISE EXCEPTION 'M25_PAYER_APPEAL_TERMINAL_IMMUTABLE: payer_appeal_case % is % and cannot be modified', OLD.id, OLD.state;
  END IF;
  IF OLD.deadline_source = 'path_rule' AND (
       NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR NEW.deadline_zone IS DISTINCT FROM OLD.deadline_zone
    OR NEW.deadline_source IS DISTINCT FROM OLD.deadline_source
    OR NEW.window_verified IS DISTINCT FROM OLD.window_verified
    OR NEW.notice_dated_on IS DISTINCT FROM OLD.notice_dated_on) THEN
    RAISE EXCEPTION 'M25_PAYER_APPEAL_DEADLINE_FROZEN: payer_appeal_case % has a computed deadline that cannot move', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_payer_appeal_case_guard" ON payer_appeal_case;--> statement-breakpoint
CREATE TRIGGER "trg_payer_appeal_case_guard" BEFORE INSERT OR UPDATE ON payer_appeal_case FOR EACH ROW EXECUTE FUNCTION m25_payer_appeal_case_guard();
