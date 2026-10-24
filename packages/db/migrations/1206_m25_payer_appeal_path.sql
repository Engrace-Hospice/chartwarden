-- M25 milestone 12a-1 (hospice ADR/TPE/QIC PRD, milestone 12: commercial and Medicare Advantage appeals): the payer
-- appeal PATH, written by a person from the customer's own contract or the payer's denial notice. NOTHING is seeded and
-- there is no platform default: a payer with no active path simply has none, and the screens say so.
--
--  * payer_appeal_path: one (organization, M40 payer, program, optional contract label) at an effective_from, versioned.
--    A path is born `draft`; a SECOND membership (not the author) verifies it, which makes it `active` and freezes it.
--    A retired path stays for the cases that snapshot it. `payer_id` is a logical M40 id (no cross-module FK).
--  * payer_appeal_path_level: the ordered levels of a path. `level_kind` is a label (`external_review` is nothing but a
--    label: no eligibility, process or form of any independent review is encoded). The filing window is all-or-none:
--    a level with an incomplete window computes nothing.
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/payer-appeal-path.ts (no pgEnum). Free text is audit-scrubbed. Idempotent (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "payer_appeal_path" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "payer_id" uuid NOT NULL, -- M40 canonical payer (logical FK; M25 does not depend on M40)
  "payer_name_snapshot" text NOT NULL CHECK (btrim("payer_name_snapshot") <> ''),
  "program" text NOT NULL CHECK ("program" IN ('commercial','medicare_advantage')),
  "contract_label" text CHECK ("contract_label" IS NULL OR btrim("contract_label") <> ''),
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','active','retired')),
  "effective_from" date NOT NULL,
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  "source_document_id" uuid, -- M22 logical FK: the contract or manual page
  "authored_by_membership_id" uuid NOT NULL,
  "verified_on" date,
  "verified_by_membership_id" uuid,
  "supersedes_path_id" uuid REFERENCES "payer_appeal_path"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- The verifier is a person other than the author (the ADR reviewer != assembler rule).
  CONSTRAINT "payer_appeal_path_verifier_not_author" CHECK ("verified_by_membership_id" IS NULL OR "verified_by_membership_id" <> "authored_by_membership_id"),
  CONSTRAINT "payer_appeal_path_verified_pair" CHECK (("verified_on" IS NULL) = ("verified_by_membership_id" IS NULL)),
  -- An active path is a verified one.
  CONSTRAINT "payer_appeal_path_active_is_verified" CHECK ("status" <> 'active' OR "verified_on" IS NOT NULL)
);--> statement-breakpoint
-- One live (draft or active) path per scope and effective date; the contract label matches case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS "payer_appeal_path_scope_ci_unique" ON "payer_appeal_path"
  ("organization_id", "payer_id", "program", (lower(btrim(coalesce("contract_label", '')))), "effective_from")
  WHERE "status" <> 'retired';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_path_payer_ix" ON "payer_appeal_path" ("organization_id", "payer_id", "effective_from");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payer_appeal_path_level" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "path_id" uuid NOT NULL REFERENCES "payer_appeal_path"("id") ON DELETE RESTRICT,
  "ordinal" integer NOT NULL CHECK ("ordinal" >= 1),
  "level_kind" text NOT NULL CHECK ("level_kind" IN ('internal','external_review','other')),
  "level_label" text NOT NULL CHECK (btrim("level_label") <> ''), -- as the contract names the level
  "who_files" text NOT NULL DEFAULT 'unknown' CHECK ("who_files" IN ('provider','member','either','unknown')),
  -- The filing window: all-or-none. Bounds are input validation only, not a payer rule.
  "filing_window_days" integer CHECK ("filing_window_days" IS NULL OR "filing_window_days" BETWEEN 1 AND 730),
  "anchor_kind" text CHECK ("anchor_kind" IS NULL OR "anchor_kind" IN ('notice_date','notice_receipt','remittance_date','prior_decision_date','other_typed')),
  "receipt_presumption_days" integer CHECK ("receipt_presumption_days" IS NULL OR "receipt_presumption_days" BETWEEN 0 AND 60),
  "day_basis" text CHECK ("day_basis" IS NULL OR "day_basis" IN ('calendar','business_us_federal')),
  "roll" text CHECK ("roll" IS NULL OR "roll" IN ('none','back','forward')),
  "decision_days" integer CHECK ("decision_days" IS NULL OR "decision_days" BETWEEN 1 AND 730), -- informational
  "form_label" text CHECK ("form_label" IS NULL OR btrim("form_label") <> ''),
  "form_document_id" uuid, -- M22 logical FK
  "channel_note" text CHECK ("channel_note" IS NULL OR btrim("channel_note") <> ''),
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payer_appeal_path_level_ordinal_unique" UNIQUE ("path_id", "ordinal"),
  CONSTRAINT "payer_appeal_path_level_window_all_or_none" CHECK (
    ("filing_window_days" IS NULL AND "anchor_kind" IS NULL AND "day_basis" IS NULL AND "roll" IS NULL AND "receipt_presumption_days" IS NULL)
    OR ("filing_window_days" IS NOT NULL AND "anchor_kind" IS NOT NULL AND "day_basis" IS NOT NULL)),
  -- A roll direction is stated exactly when the day basis is the business one.
  CONSTRAINT "payer_appeal_path_level_roll_matches_basis" CHECK (("day_basis" = 'business_us_federal') = ("roll" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_path_level_org_ix" ON "payer_appeal_path_level" ("organization_id", "created_at");--> statement-breakpoint

ALTER TABLE "payer_appeal_path" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_appeal_path" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "payer_appeal_path_org" ON "payer_appeal_path";--> statement-breakpoint
CREATE POLICY "payer_appeal_path_org" ON "payer_appeal_path" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "payer_appeal_path_level" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_appeal_path_level" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "payer_appeal_path_level_org" ON "payer_appeal_path_level";--> statement-breakpoint
CREATE POLICY "payer_appeal_path_level_org" ON "payer_appeal_path_level" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- A path's scope and content never change after insert; only its lifecycle moves (verify -> active, retire). Levels are
-- insert-only: fixing a typo means retiring the draft and writing a new one. No DELETE for the app role.
GRANT SELECT, INSERT ON "payer_appeal_path" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "verified_on", "verified_by_membership_id", "version", "updated_at") ON "payer_appeal_path" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "payer_appeal_path" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "payer_appeal_path_level" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "payer_appeal_path_level" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). Every free-text column is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_payer_appeal_path() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['contract_label','source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'payer_appeal_path.' || lower(TG_OP), 'payer_appeal_path', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payer_appeal_path() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_payer_appeal_path" ON payer_appeal_path;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payer_appeal_path" AFTER INSERT OR UPDATE OR DELETE ON payer_appeal_path FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payer_appeal_path();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_payer_appeal_path_level() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['level_label','form_label','channel_note','source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'payer_appeal_path_level.' || lower(TG_OP), 'payer_appeal_path_level', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payer_appeal_path_level() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_payer_appeal_path_level" ON payer_appeal_path_level;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payer_appeal_path_level" AFTER INSERT OR UPDATE OR DELETE ON payer_appeal_path_level FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payer_appeal_path_level();--> statement-breakpoint

-- A path is born a draft; once active it is frozen (only active -> retired may follow); a retired path never changes.
-- A superseded path must be the same scope (a FK cannot prove it).
CREATE OR REPLACE FUNCTION m25_payer_appeal_path_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prior record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'M25_PAYER_PATH_BORN_DRAFT: a payer appeal path is created as a draft and verified by a second person';
    END IF;
    IF NEW.supersedes_path_id IS NOT NULL THEN
      SELECT payer_id, program, lower(btrim(coalesce(contract_label, ''))) AS label INTO v_prior
        FROM payer_appeal_path WHERE id = NEW.supersedes_path_id AND organization_id = NEW.organization_id;
      IF NOT FOUND OR v_prior.payer_id <> NEW.payer_id OR v_prior.program <> NEW.program
         OR v_prior.label <> lower(btrim(coalesce(NEW.contract_label, ''))) THEN
        RAISE EXCEPTION 'M25_PAYER_PATH_SUPERSEDES: the superseded path is not visible or is a different payer, program or contract';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'M25_PAYER_PATH_FROZEN: payer_appeal_path % is retired and cannot change', OLD.id;
  END IF;
  IF OLD.status = 'active' AND (
       NEW.status <> 'retired'
    OR NEW.verified_on IS DISTINCT FROM OLD.verified_on
    OR NEW.verified_by_membership_id IS DISTINCT FROM OLD.verified_by_membership_id) THEN
    RAISE EXCEPTION 'M25_PAYER_PATH_FROZEN: payer_appeal_path % is active; only retiring it is allowed', OLD.id;
  END IF;
  -- Activation is decided here, atomically with the UPDATE (the row is locked by it): a second person (the CHECK above also
  -- refuses author = verifier), an active membership of this organization, and at least one level. An app-side read-then-write
  -- check could be raced; this cannot. A concurrent second verify finds the row already active and hits the frozen branch.
  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    IF NEW.verified_by_membership_id IS NULL OR NEW.verified_by_membership_id = OLD.authored_by_membership_id THEN
      RAISE EXCEPTION 'M25_PAYER_PATH_VERIFIER: a payer appeal path is activated by a person other than its author';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.verified_by_membership_id AND m.organization_id = OLD.organization_id) THEN
      RAISE EXCEPTION 'M25_PAYER_PATH_VERIFIER: the verifier is not a member of this organization';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payer_appeal_path_level l WHERE l.path_id = OLD.id) THEN
      RAISE EXCEPTION 'M25_PAYER_PATH_NO_LEVELS: a path with no levels cannot be activated';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_payer_appeal_path_guard" ON payer_appeal_path;--> statement-breakpoint
CREATE TRIGGER "trg_payer_appeal_path_guard" BEFORE INSERT OR UPDATE ON payer_appeal_path FOR EACH ROW EXECUTE FUNCTION m25_payer_appeal_path_guard();--> statement-breakpoint

-- A level hangs under a draft path of this organization (RLS hides another tenant's path, so a cross-tenant id fails
-- closed); an active or retired path's levels never change.
CREATE OR REPLACE FUNCTION m25_payer_appeal_path_level_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM payer_appeal_path WHERE id = NEW.path_id AND organization_id = NEW.organization_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'M25_PAYER_PATH_LEVEL_PARENT: payer_appeal_path % is not visible to this organization', NEW.path_id;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'M25_PAYER_PATH_FROZEN: payer_appeal_path % is % and its levels cannot change', NEW.path_id, v_status;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_payer_appeal_path_level_guard" ON payer_appeal_path_level;--> statement-breakpoint
CREATE TRIGGER "trg_payer_appeal_path_level_guard" BEFORE INSERT OR UPDATE ON payer_appeal_path_level FOR EACH ROW EXECUTE FUNCTION m25_payer_appeal_path_level_guard();--> statement-breakpoint

-- Permissions. payer_appeal.read / .manage: see and work a payer appeal case (1207). payer_appeal_path.read / .manage:
-- see and draft the organization's payer appeal paths (a billing-lead decision). payer_appeal_path.verify: the second
-- person who checks a draft against the contract and activates it. Full-catalog roles (administrator, org_admin)
-- receive every non-platform key from the template materializer; existing tenants' roles get them from 1209.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('payer_appeal.read', 'payer_appeal_case', 'read', 'billing', 'provider_entity_scope', ''),
  ('payer_appeal.manage', 'payer_appeal_case', 'manage', 'billing', 'provider_entity_scope', ''),
  ('payer_appeal_path.read', 'payer_appeal_path', 'read', 'billing', 'none', ''),
  ('payer_appeal_path.manage', 'payer_appeal_path', 'manage', 'billing', 'none', ''),
  ('payer_appeal_path.verify', 'payer_appeal_path', 'verify', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;
