-- M41 Billing - Commercial, payer and plan model (issue #721, ADR-0100 D6). Three org-scoped tables; NO PHI in any of them
-- (no patient, member, subscriber or group identifier; the only people referenced are none).
--
--   commercial_payer_plan       one tenant's plan for an M40 payer: claim filing indicator (837I SBR09), the authorization
--                               requirement and effective dating. `payer_id` is a LOGICAL id of an M40 canonical `payer`
--                               (no cross-module FK); a trigger proves it names an active payer of kind 'commercial' or 'other'
--                               ('other' carries TRICARE, FEHBP, VA, workers' comp and similar programs), so a Medicare,
--                               Medicaid or Medicare Advantage payer can never carry a commercial plan (hospice for a
--                               Medicare Advantage enrollee is billed to the Medicare contractor - ADR-0100 D7).
--   commercial_payer_route      the payer id a given clearinghouse routes this plan on (837I NM109 of loop 2010BB),
--                               effective dated, at most one in effect per (plan, clearinghouse).
--   commercial_contract_rate    contract terms per level of care: revenue code, rate basis (per diem / per hour / percent of
--                               charges), amount, effective dated, at most one in effect per (plan, level of care).
--
-- NOTHING IS SEEDED. Closed sets are text + CHECK mirrored in packages/types/src/commercial-billing.ts (the M25 precedent,
-- no pgEnum); commercial-billing.test.ts fails on drift. Canonical app.org_id RLS, FORCEd, no DELETE for the app role.
-- Idempotent on purpose (the 1116/1117 renumber lesson).

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_payer_plan" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "payer_id" uuid NOT NULL, -- M40 canonical payer (logical FK; checked by trigger below)
  "plan_name" text NOT NULL CHECK (btrim("plan_name") <> '' AND char_length("plan_name") <= 120),
  "claim_filing_indicator" text NOT NULL CHECK ("claim_filing_indicator" IN ('11','12','13','14','15','17','AM','BL','CH','CI','DS','FI','HM','LM','OF','VA','WC','ZZ')),
  -- Unknown is stated, not defaulted to "no": confirm_with_payer is the safe default (send gate treats it as required).
  "authorization_requirement" text NOT NULL DEFAULT 'confirm_with_payer' CHECK ("authorization_requirement" IN ('not_required','required_at_admission','required_per_level_of_care','confirm_with_payer')),
  "authorization_lead_days" smallint CHECK ("authorization_lead_days" IS NULL OR "authorization_lead_days" BETWEEN 0 AND 365),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_payer_plan_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "commercial_payer_plan_auth_lead" CHECK ("authorization_lead_days" IS NULL OR "authorization_requirement" <> 'not_required'),
  -- composite parent key so children can prove they share the plan's organization
  CONSTRAINT "commercial_payer_plan_id_org_key" UNIQUE ("id", "organization_id"),
  -- one plan name per payer is in effect on any day
  CONSTRAINT "commercial_payer_plan_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =, "payer_id" WITH =, (lower(btrim("plan_name"))) WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_payer_plan_org_payer_ix" ON "commercial_payer_plan" ("organization_id", "payer_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_payer_route" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL,
  -- the platform clearinghouse binding's key (ADR-0053), e.g. 'stedi'; a label, never a credential
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- the payer id that clearinghouse routes on (not the member id; not PHI)
  "clearinghouse_payer_id" text NOT NULL CHECK ("clearinghouse_payer_id" ~ '^[A-Za-z0-9._-]{1,40}$'),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_payer_route_plan_fk" FOREIGN KEY ("plan_id", "organization_id") REFERENCES "commercial_payer_plan"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_payer_route_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "commercial_payer_route_no_overlap" EXCLUDE USING gist (
    "plan_id" WITH =, "clearinghouse_key" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_payer_route_plan_ix" ON "commercial_payer_route" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_payer_route_org_ix" ON "commercial_payer_route" ("organization_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_contract_rate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL,
  "level_of_care" text NOT NULL CHECK ("level_of_care" IN ('routine_home_care','continuous_home_care','inpatient_respite','general_inpatient')),
  -- the revenue code the CONTRACT bills this level under (standard: 0651/0652/0655/0656); a contract may differ
  "revenue_code" text NOT NULL CHECK ("revenue_code" ~ '^0[0-9]{3}$'),
  "rate_basis" text NOT NULL CHECK ("rate_basis" IN ('per_diem','per_hour','percent_of_charges')),
  "rate_cents" integer CHECK ("rate_cents" IS NULL OR "rate_cents" >= 0),
  "percent_of_charges" numeric(5,2) CHECK ("percent_of_charges" IS NULL OR ("percent_of_charges" > 0 AND "percent_of_charges" <= 100)),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_contract_rate_plan_fk" FOREIGN KEY ("plan_id", "organization_id") REFERENCES "commercial_payer_plan"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_contract_rate_hourly" CHECK ("rate_basis" <> 'per_hour' OR "level_of_care" = 'continuous_home_care'),
  CONSTRAINT "commercial_contract_rate_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  -- exactly the amount the basis names
  CONSTRAINT "commercial_contract_rate_amount" CHECK (
    ("rate_basis" = 'percent_of_charges' AND "percent_of_charges" IS NOT NULL AND "rate_cents" IS NULL)
    OR ("rate_basis" <> 'percent_of_charges' AND "rate_cents" IS NOT NULL AND "percent_of_charges" IS NULL)),
  CONSTRAINT "commercial_contract_rate_no_overlap" EXCLUDE USING gist (
    "plan_id" WITH =, "level_of_care" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_contract_rate_plan_ix" ON "commercial_contract_rate" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_contract_rate_org_ix" ON "commercial_contract_rate" ("organization_id");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd; the app role has no DELETE on any of the three.
ALTER TABLE "commercial_payer_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_payer_plan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_payer_plan_org" ON "commercial_payer_plan";--> statement-breakpoint
CREATE POLICY "commercial_payer_plan_org" ON "commercial_payer_plan" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_payer_route" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_payer_route" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_payer_route_org" ON "commercial_payer_route";--> statement-breakpoint
CREATE POLICY "commercial_payer_route_org" ON "commercial_payer_route" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_contract_rate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_contract_rate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_contract_rate_org" ON "commercial_contract_rate";--> statement-breakpoint
CREATE POLICY "commercial_contract_rate_org" ON "commercial_contract_rate" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- A row's anchor (payer, plan, level of care, clearinghouse) never changes: a different anchor is a different row.
GRANT SELECT, INSERT ON "commercial_payer_plan" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("plan_name", "claim_filing_indicator", "authorization_requirement", "authorization_lead_days", "effective_to", "updated_at") ON "commercial_payer_plan" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_payer_plan" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_payer_route" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("clearinghouse_payer_id", "effective_to", "updated_at") ON "commercial_payer_route" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_payer_route" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_contract_rate" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("revenue_code", "rate_basis", "rate_cents", "percent_of_charges", "effective_to", "updated_at") ON "commercial_contract_rate" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_contract_rate" TO chartwarden_admin;--> statement-breakpoint

-- The plan's payer must be an ACTIVE commercial (or other non-Medicare program) M40 payer; no cross-module FK, so the
-- database proves it here. Checked on INSERT only: a payer merged or deactivated later leaves its plans in place and M40
-- merge handling must repoint them. Route and rate periods are NOT bounded by the plan's period here; claim assembly (#722)
-- intersects all three.
CREATE OR REPLACE FUNCTION m41_commercial_payer_plan_payer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payer WHERE id = NEW.payer_id AND kind IN ('commercial','other') AND status = 'active') THEN
    RAISE EXCEPTION 'M41_PLAN_PAYER_NOT_COMMERCIAL: payer % is not an active commercial or other-program payer', NEW.payer_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_commercial_payer_plan_payer_guard" ON "commercial_payer_plan";--> statement-breakpoint
CREATE TRIGGER "trg_commercial_payer_plan_payer_guard" BEFORE INSERT ON "commercial_payer_plan" FOR EACH ROW EXECUTE FUNCTION m41_commercial_payer_plan_payer_guard();--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). No free text and no PHI in these tables, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_payer_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_payer_plan.' || lower(TG_OP), 'commercial_payer_plan', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_payer_plan() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_payer_plan" ON commercial_payer_plan;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_payer_plan" AFTER INSERT OR UPDATE OR DELETE ON commercial_payer_plan FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_payer_plan();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_commercial_payer_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_payer_route.' || lower(TG_OP), 'commercial_payer_route', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_payer_route() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_payer_route" ON commercial_payer_route;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_payer_route" AFTER INSERT OR UPDATE OR DELETE ON commercial_payer_route FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_payer_route();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_commercial_contract_rate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_contract_rate.' || lower(TG_OP), 'commercial_contract_rate', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_contract_rate() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_contract_rate" ON commercial_contract_rate;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_contract_rate" AFTER INSERT OR UPDATE OR DELETE ON commercial_contract_rate FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_contract_rate();
