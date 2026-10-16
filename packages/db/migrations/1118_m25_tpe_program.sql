-- M25 TPE program tracker (hospice ADR/TPE/QIC PRD, milestone 5): a MAC's Targeted Probe and Educate program for a
-- provider entity, its rounds (at most 3), the sampled claims of each round (linked to their ADRs), and the
-- per-organization exit-threshold rules. The tracker RECORDS what the MAC sends; the MAC's results letter (its error
-- rate and its compliant / non_compliant result) is the official value. Per-MAC exit thresholds are NOT verified, so
-- tpe_mac_rule rows are tenant data with NO seed and NO default in code: a MAC with no rule shows "no threshold
-- confirmed". Org-scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role); closed sets are text +
-- CHECK mirrored in domain/tpe.ts, so there is no new pgEnum. There are no history tables: the write-audit triggers
-- are the trail.

CREATE TABLE "tpe_mac_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mac_name" text NOT NULL CHECK (btrim("mac_name") <> ''),
  "exit_error_rate_pct" numeric(5,2) NOT NULL CHECK ("exit_error_rate_pct" BETWEEN 0 AND 100),
  "source_note" text,
  "verified_on" date,
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- MAC names match case-insensitively, so the rule key must too.
CREATE UNIQUE INDEX "tpe_mac_rule_key" ON "tpe_mac_rule" ("organization_id", lower(btrim("mac_name")), "effective_from");--> statement-breakpoint
CREATE INDEX "tpe_mac_rule_org_ix" ON "tpe_mac_rule" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "tpe_program" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "mac_name" text NOT NULL CHECK (btrim("mac_name") <> ''),
  "opened_on" date NOT NULL,
  "state" text NOT NULL DEFAULT 'active' CHECK ("state" IN ('active','compliant','referred','closed')),
  -- The outcome facts, typed from the CMS / MAC letter: the relief end date is never computed.
  "outcome_on" date,
  "relief_until" date,
  "referral_kinds" text[] NOT NULL DEFAULT '{}'
    CHECK ("referral_kinds" <@ ARRAY['prepay_review','extrapolation','rac','other']::text[]),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tpe_program_compliant_has_outcome" CHECK ("state" <> 'compliant' OR "outcome_on" IS NOT NULL),
  CONSTRAINT "tpe_program_referred_has_outcome" CHECK ("state" <> 'referred'
    OR ("outcome_on" IS NOT NULL AND cardinality("referral_kinds") > 0)),
  -- Referral types belong to a referral only, and a relief end date to a relief only.
  CONSTRAINT "tpe_program_compliant_no_referral" CHECK ("state" <> 'compliant' OR cardinality("referral_kinds") = 0),
  CONSTRAINT "tpe_program_referred_no_relief" CHECK ("state" <> 'referred' OR "relief_until" IS NULL)
);--> statement-breakpoint
-- One active program per provider entity and MAC: a second would double-count the same rounds.
CREATE UNIQUE INDEX "tpe_program_active_per_mac" ON "tpe_program"
  ("organization_id", "provider_entity_id", lower(btrim("mac_name"))) WHERE "state" = 'active';--> statement-breakpoint
CREATE INDEX "ix_tpe_program_provider" ON "tpe_program" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "tpe_program_org_ix" ON "tpe_program" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "tpe_round" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "tpe_program_id" uuid NOT NULL REFERENCES "tpe_program"("id") ON DELETE RESTRICT,
  "round_number" integer NOT NULL CHECK ("round_number" BETWEEN 1 AND 3),
  "notice_on" date NOT NULL,
  "results_on" date,
  -- What the MAC's results letter says. The letter is official; the claim-count rate on screen is advisory.
  "mac_error_rate_pct" numeric(5,2) CHECK ("mac_error_rate_pct" BETWEEN 0 AND 100),
  "mac_result" text CHECK ("mac_result" IN ('compliant','non_compliant')),
  -- The threshold in force when the results were recorded: a later rule edit never rewrites it.
  "threshold_pct" numeric(5,2) CHECK ("threshold_pct" BETWEEN 0 AND 100),
  "threshold_source" text CHECK ("threshold_source" IN ('org_rule','none')),
  "threshold_verified" boolean NOT NULL DEFAULT false,
  "education_on" date,
  "education_note" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tpe_round_unique" UNIQUE ("tpe_program_id", "round_number"),
  CONSTRAINT "tpe_round_result_has_letter_date" CHECK (("mac_result" IS NULL) = ("results_on" IS NULL)),
  CONSTRAINT "tpe_round_rate_has_results" CHECK ("mac_error_rate_pct" IS NULL OR "results_on" IS NOT NULL),
  CONSTRAINT "tpe_round_threshold_snapshot" CHECK (("threshold_source" IS NULL) = ("results_on" IS NULL)
    AND (coalesce("threshold_source", '') = 'org_rule') = ("threshold_pct" IS NOT NULL)),
  CONSTRAINT "tpe_round_results_after_notice" CHECK ("results_on" IS NULL OR "results_on" >= "notice_on"),
  CONSTRAINT "tpe_round_education_after_notice" CHECK ("education_on" IS NULL OR "education_on" >= "notice_on")
);--> statement-breakpoint
CREATE INDEX "tpe_round_org_ix" ON "tpe_round" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "tpe_round_claim" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "tpe_round_id" uuid NOT NULL REFERENCES "tpe_round"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "adr_case_id" uuid REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "result" text NOT NULL DEFAULT 'pending' CHECK ("result" IN ('pending','no_error','error')),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tpe_round_claim_unique" UNIQUE ("tpe_round_id", "claim_id")
);--> statement-breakpoint
CREATE INDEX "ix_tpe_round_claim_adr" ON "tpe_round_claim" ("adr_case_id") WHERE "adr_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tpe_round_claim_org_ix" ON "tpe_round_claim" ("organization_id", "created_at");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd, app role without DELETE.
ALTER TABLE "tpe_mac_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tpe_mac_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tpe_mac_rule_org" ON "tpe_mac_rule" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The MAC and effective day are the rule's key and never change: only the threshold and its provenance are updatable.
GRANT SELECT, INSERT ON "tpe_mac_rule" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("exit_error_rate_pct", "source_note", "verified_on", "version") ON "tpe_mac_rule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tpe_mac_rule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tpe_program" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tpe_program" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tpe_program_org" ON "tpe_program" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The anchor (provider entity, MAC, opening day) never changes after logging: only the outcome columns are updatable.
GRANT SELECT, INSERT ON "tpe_program" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "version", "outcome_on", "relief_until", "referral_kinds") ON "tpe_program" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tpe_program" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tpe_round" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tpe_round" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tpe_round_org" ON "tpe_round" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The program, number and notice day never change: only the facts the MAC sends later are updatable.
GRANT SELECT, INSERT ON "tpe_round" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("results_on", "mac_error_rate_pct", "mac_result", "threshold_pct", "threshold_source",
  "threshold_verified", "education_on", "education_note", "version") ON "tpe_round" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tpe_round" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tpe_round_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tpe_round_claim" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tpe_round_claim_org" ON "tpe_round_claim" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "tpe_round_claim" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("adr_case_id", "result", "version") ON "tpe_round_claim" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tpe_round_claim" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The free-text notes are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_tpe_mac_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tpe_mac_rule.' || lower(TG_OP), 'tpe_mac_rule', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tpe_mac_rule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tpe_mac_rule" AFTER INSERT OR UPDATE OR DELETE ON tpe_mac_rule FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tpe_mac_rule();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tpe_program() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tpe_program.' || lower(TG_OP), 'tpe_program', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tpe_program() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tpe_program" AFTER INSERT OR UPDATE OR DELETE ON tpe_program FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tpe_program();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tpe_round() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['education_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tpe_round.' || lower(TG_OP), 'tpe_round', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tpe_round() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tpe_round" AFTER INSERT OR UPDATE OR DELETE ON tpe_round FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tpe_round();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tpe_round_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tpe_round_claim.' || lower(TG_OP), 'tpe_round_claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tpe_round_claim() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tpe_round_claim" AFTER INSERT OR UPDATE OR DELETE ON tpe_round_claim FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tpe_round_claim();--> statement-breakpoint

-- A closed program is frozen entirely, only legal state edges are accepted (the same table as domain/tpe.ts), and a
-- recorded outcome cannot be rewritten: a MAC's final letter is a fact, so SQL that bypasses the service cannot
-- reopen a closed program or move one backwards.
CREATE OR REPLACE FUNCTION m25_tpe_program_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'closed' THEN
    RAISE EXCEPTION 'M25_TPE_PROGRAM_CLOSED: tpe_program % is closed and cannot be modified', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'active' AND NEW.state IN ('compliant','referred','closed'))
    OR (OLD.state IN ('compliant','referred') AND NEW.state = 'closed')) THEN
    RAISE EXCEPTION 'M25_TPE_ILLEGAL_TRANSITION: tpe_program % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  IF OLD.state <> 'active' AND (
       NEW.outcome_on IS DISTINCT FROM OLD.outcome_on
    OR NEW.relief_until IS DISTINCT FROM OLD.relief_until
    OR NEW.referral_kinds IS DISTINCT FROM OLD.referral_kinds) THEN
    RAISE EXCEPTION 'M25_TPE_OUTCOME_IMMUTABLE: tpe_program % has a recorded outcome that cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_tpe_program_guard" BEFORE UPDATE ON tpe_program FOR EACH ROW EXECUTE FUNCTION m25_tpe_program_guard();--> statement-breakpoint

-- Nothing under a closed program changes either: a round or a sampled claim written against one is refused.
CREATE OR REPLACE FUNCTION m25_tpe_round_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tpe_program WHERE id = NEW.tpe_program_id AND state = 'closed') THEN
    RAISE EXCEPTION 'M25_TPE_PROGRAM_CLOSED: tpe_program % is closed; its rounds cannot change', NEW.tpe_program_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_tpe_round_guard" BEFORE INSERT OR UPDATE ON tpe_round FOR EACH ROW EXECUTE FUNCTION m25_tpe_round_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION m25_tpe_round_claim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tpe_round r JOIN tpe_program p ON p.id = r.tpe_program_id
              WHERE r.id = NEW.tpe_round_id AND p.state = 'closed') THEN
    RAISE EXCEPTION 'M25_TPE_PROGRAM_CLOSED: the program of tpe_round % is closed; its sampled claims cannot change', NEW.tpe_round_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_tpe_round_claim_guard" BEFORE INSERT OR UPDATE ON tpe_round_claim FOR EACH ROW EXECUTE FUNCTION m25_tpe_round_claim_guard();--> statement-breakpoint

-- tpe.read: see TPE programs, rounds and thresholds. tpe.manage: open a program and record rounds, results, education,
-- sampled claims and the outcome. tpe_rule.manage: edit the organization's per-MAC exit thresholds (a billing-lead
-- decision, like mac_rule.manage). Full-catalog roles receive them from the template materializer; existing
-- tenants' roles get them from the next migration.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tpe.read', 'tpe_program', 'read', 'billing', 'provider_entity_scope', ''),
  ('tpe.manage', 'tpe_program', 'manage', 'billing', 'provider_entity_scope', ''),
  ('tpe_rule.manage', 'tpe_mac_rule', 'manage', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;
