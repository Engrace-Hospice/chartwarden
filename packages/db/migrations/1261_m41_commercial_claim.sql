-- M41 Billing - Commercial, claim assembly and validation (issue #722, ADR-0100 D6/D7/D9). Seven org-scoped, PHI-bearing tables
-- (a claim names a patient; the three-column rule applies), a payer-state seam function and one column on the plan:
--
--   commercial_authorization         pre-authorization on file: patient, plan, optional level of care, approved period, date obtained.
--   commercial_claim                 the assembled 837I header: plan and payer-route snapshot, TOB, window, totals, COB (secondary
--                                    Medicare / Medicaid), diagnoses and attending snapshot, state (draft / ready / void).
--   commercial_claim_line            one revenue-code line per level-of-care segment, priced from the contract rate in effect.
--   commercial_claim_state_history   immutable transition log.
--   commercial_validation_run        one validation pass over a claim (append-only).
--   commercial_validation_result     one rule outcome (rule key, severity, overridable, evidence hash, actionable message).
--   commercial_validation_override   an audited override of one overridable failing result (reason >= 40 chars, M4 audit event id).
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- packages/types/src/commercial-claim.ts (no pgEnum). Member ids and MBIs are NEVER stored: the 837I render reads them
-- transiently through the M5 coverage seam. Idempotent on purpose (the 1116/1117 renumber lesson).

ALTER TABLE "commercial_payer_plan" ADD COLUMN IF NOT EXISTS "site_of_service_hcpcs_required" boolean NOT NULL DEFAULT false;--> statement-breakpoint
GRANT UPDATE ("site_of_service_hcpcs_required") ON "commercial_payer_plan" TO chartwarden_app;--> statement-breakpoint

-- Seam over the M40 payer master for claim assembly: the plan's payer may have been merged or deactivated after the plan was
-- created (the 1260 guard runs on INSERT only). Assembly refuses a plan whose payer is no longer active and names the survivor.
CREATE OR REPLACE FUNCTION m41_payer_state(p_payer_id uuid) RETURNS TABLE(status text, kind text, merged_into_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT p.status::text, p.kind::text, p.merged_into_id FROM payer p WHERE p.id = p_payer_id;
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m41_payer_state(uuid) TO chartwarden_app;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_authorization" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL, -- M5 patient (logical id)
  "plan_id" uuid NOT NULL,
  "authorization_number" text NOT NULL CHECK ("authorization_number" ~ '^[A-Za-z0-9._-]{1,50}$'),
  -- NULL = covers every level of care; a value = that level only (plans that require authorization per level of care)
  "level_of_care" text CHECK ("level_of_care" IS NULL OR "level_of_care" IN ('routine_home_care','continuous_home_care','inpatient_respite','general_inpatient')),
  "status" text NOT NULL DEFAULT 'approved' CHECK ("status" IN ('approved','denied','voided')),
  "obtained_on" date NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_by_membership_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_authorization_plan_fk" FOREIGN KEY ("plan_id", "organization_id") REFERENCES "commercial_payer_plan"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_authorization_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "commercial_authorization_number_key" UNIQUE ("organization_id", "plan_id", "patient_id", "authorization_number")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_plan_ix" ON "commercial_authorization" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_org_ix" ON "commercial_authorization" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_pe_ix" ON "commercial_authorization" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_location_ix" ON "commercial_authorization" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_patient_ix" ON "commercial_authorization" ("organization_id", "patient_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_claim" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL, -- M6 admission (logical id)
  "plan_id" uuid NOT NULL,
  "primary_patient_payer_id" uuid NOT NULL, -- M5 coverage row (an id, never the member id)
  "secondary_patient_payer_id" uuid,
  "secondary_payer_kind" text CHECK ("secondary_payer_kind" IS NULL OR "secondary_payer_kind" IN ('medicare','medicaid')),
  "claim_filing_indicator" text NOT NULL CHECK ("claim_filing_indicator" IN ('11','12','13','14','15','17','AM','BL','CH','CI','DS','FI','HM','LM','OF','VA','WC','ZZ')),
  "clearinghouse_key" text CHECK ("clearinghouse_key" IS NULL OR "clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "clearinghouse_payer_id" text CHECK ("clearinghouse_payer_id" IS NULL OR "clearinghouse_payer_id" ~ '^[A-Za-z0-9._-]{1,40}$'),
  "tob" char(3) NOT NULL CHECK ("tob" ~ '^81[1-4]$'),
  "frequency_code" char(1) NOT NULL CHECK ("frequency_code" ~ '^[1-4]$'),
  "service_from" date NOT NULL,
  "service_to" date NOT NULL,
  "admission_date" date NOT NULL,
  "admission_type_code" text,
  "admission_source_code" text,
  "patient_status_code" text NOT NULL CHECK ("patient_status_code" ~ '^[0-9A-Z]{2}$'),
  "claim_control_number" text NOT NULL CHECK ("claim_control_number" ~ '^[A-Za-z0-9-]{1,38}$'),
  "diagnoses" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("diagnoses") = 'array'),
  "attending_npi" text CHECK ("attending_npi" IS NULL OR "attending_npi" ~ '^[0-9]{10}$'),
  "attending_first_name" text,
  "attending_last_name" text,
  "total_charge_cents" bigint NOT NULL CHECK ("total_charge_cents" >= 0),
  "expected_payment_cents" bigint CHECK ("expected_payment_cents" IS NULL OR "expected_payment_cents" >= 0),
  "state" text NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft','ready','void')),
  "latest_validation_run_id" uuid,
  "ready_at" timestamptz,
  "created_by_membership_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_claim_plan_fk" FOREIGN KEY ("plan_id", "organization_id") REFERENCES "commercial_payer_plan"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_claim_window" CHECK ("service_to" >= "service_from"),
  CONSTRAINT "commercial_claim_cob_pair" CHECK (("secondary_patient_payer_id" IS NULL) = ("secondary_payer_kind" IS NULL)),
  CONSTRAINT "commercial_claim_ready_stamp" CHECK (("state" = 'ready') = ("ready_at" IS NOT NULL)),
  CONSTRAINT "commercial_claim_id_org_key" UNIQUE ("id", "organization_id"),
  CONSTRAINT "commercial_claim_control_number_key" UNIQUE ("organization_id", "claim_control_number")
);--> statement-breakpoint
-- one live claim per patient, entity and exact window (the M23 claim_active_by_range_uq shape); overlap is also refused in the service
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_claim_active_by_range_uq" ON "commercial_claim" ("organization_id", "provider_entity_id", "patient_id", "service_from", "service_to") WHERE "state" <> 'void';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_plan_ix" ON "commercial_claim" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_pe_ix" ON "commercial_claim" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_location_ix" ON "commercial_claim" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_patient_ix" ON "commercial_claim" ("organization_id", "patient_id", "service_from");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_claim_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "line_number" integer NOT NULL CHECK ("line_number" >= 1),
  "level_of_care" text NOT NULL CHECK ("level_of_care" IN ('routine_home_care','continuous_home_care','inpatient_respite','general_inpatient')),
  "revenue_code" text NOT NULL CHECK ("revenue_code" ~ '^0[0-9]{3}$'),
  "hcpcs_code" text CHECK ("hcpcs_code" IS NULL OR "hcpcs_code" ~ '^[A-Z0-9]{5}$'),
  "service_from" date NOT NULL,
  "service_to" date NOT NULL,
  "units" integer NOT NULL CHECK ("units" >= 1),
  "unit_rate_cents" bigint CHECK ("unit_rate_cents" IS NULL OR "unit_rate_cents" >= 0),
  "line_charge_cents" bigint NOT NULL CHECK ("line_charge_cents" >= 0),
  -- the contract rate row this line was priced from (NULL when no rate was in effect: a hard block, the line is unpriced)
  "contract_rate_id" uuid REFERENCES "commercial_contract_rate"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_claim_line_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_claim_line_window" CHECK ("service_to" >= "service_from"),
  CONSTRAINT "commercial_claim_line_number_key" UNIQUE ("claim_id", "line_number")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_line_org_ix" ON "commercial_claim_line" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_line_pe_ix" ON "commercial_claim_line" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_line_location_ix" ON "commercial_claim_line" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_line_rate_ix" ON "commercial_claim_line" ("contract_rate_id") WHERE "contract_rate_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_claim_state_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "from_state" text CHECK ("from_state" IS NULL OR "from_state" IN ('draft','ready','void')),
  "to_state" text NOT NULL CHECK ("to_state" IN ('draft','ready','void')),
  "actor_kind" text NOT NULL,
  "actor_membership_id" uuid,
  "validation_run_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_claim_state_history_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_state_history_claim_ix" ON "commercial_claim_state_history" ("claim_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_state_history_org_ix" ON "commercial_claim_state_history" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_state_history_pe_ix" ON "commercial_claim_state_history" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_state_history_location_ix" ON "commercial_claim_state_history" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_validation_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "trigger" text NOT NULL CHECK ("trigger" IN ('initial_assembly','manual_re_run','ready_check')),
  "outcome" text NOT NULL CHECK ("outcome" IN ('all_pass','failures_present')),
  "rule_set_version" integer NOT NULL CHECK ("rule_set_version" >= 1),
  "rules_executed" integer NOT NULL CHECK ("rules_executed" >= 0),
  "rules_failed" integer NOT NULL CHECK ("rules_failed" >= 0),
  "initiated_by_membership_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_validation_run_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_validation_run_id_org_key" UNIQUE ("id", "organization_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_run_claim_ix" ON "commercial_validation_run" ("claim_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_run_org_ix" ON "commercial_validation_run" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_run_pe_ix" ON "commercial_validation_run" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_run_location_ix" ON "commercial_validation_run" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_validation_result" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "validation_run_id" uuid NOT NULL,
  "rule_key" text NOT NULL CHECK ("rule_key" ~ '^[a-z][a-z0-9_]{2,60}$'),
  "severity" text NOT NULL CHECK ("severity" IN ('error','warn','info')),
  "outcome" text NOT NULL CHECK ("outcome" IN ('pass','fail','info')),
  -- a failing result with overridable = false is a HARD BLOCK: no role can override it (a policy change is the only way out)
  "overridable" boolean NOT NULL,
  -- sha256 of the rule's evidence: an override binds to (claim, rule, evidence), so it survives a re-run on identical facts only
  "evidence_hash" char(64) NOT NULL CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$'),
  "message" text NOT NULL CHECK (char_length("message") <= 600),
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("evidence") = 'object'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_validation_result_run_fk" FOREIGN KEY ("validation_run_id", "organization_id") REFERENCES "commercial_validation_run"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_validation_result_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_validation_result_id_org_key" UNIQUE ("id", "organization_id"),
  CONSTRAINT "commercial_validation_result_run_rule_key" UNIQUE ("validation_run_id", "rule_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_claim_ix" ON "commercial_validation_result" ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_org_ix" ON "commercial_validation_result" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_pe_ix" ON "commercial_validation_result" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_location_ix" ON "commercial_validation_result" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_validation_override" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "validation_result_id" uuid NOT NULL,
  "rule_key" text NOT NULL,
  "evidence_hash" char(64) NOT NULL,
  "override_membership_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (char_length(btrim("reason")) >= 40 AND char_length("reason") <= 2000),
  -- the prominent M4 audit_event written in the same transaction (no FK: audit_event is partitioned)
  "m4_audit_event_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_validation_override_result_fk" FOREIGN KEY ("validation_result_id", "organization_id") REFERENCES "commercial_validation_result"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_validation_override_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_validation_override_result_uq" UNIQUE ("validation_result_id"),
  CONSTRAINT "commercial_validation_override_fact_uq" UNIQUE ("claim_id", "rule_key", "evidence_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_override_org_ix" ON "commercial_validation_override" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_override_pe_ix" ON "commercial_validation_override" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_override_location_ix" ON "commercial_validation_override" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

-- Composite (id, organization_id) foreign keys need an index on exactly those columns (fk-index-coverage live suite). The three
-- 1260 tables missed theirs; they are added here, idempotently, together with this migration's own.
CREATE INDEX IF NOT EXISTS "commercial_payer_route_fk_ix" ON "commercial_payer_route" ("plan_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_contract_rate_fk_ix" ON "commercial_contract_rate" ("plan_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_authorization_fk_ix" ON "commercial_authorization" ("plan_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_fk_ix" ON "commercial_claim" ("plan_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_line_fk_ix" ON "commercial_claim_line" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_claim_state_history_fk_ix" ON "commercial_claim_state_history" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_run_fk_ix" ON "commercial_validation_run" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_fk_ix" ON "commercial_validation_result" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_override_fk_ix" ON "commercial_validation_override" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_result_run_fk_ix" ON "commercial_validation_result" ("validation_run_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_validation_override_result_fk_ix" ON "commercial_validation_override" ("validation_result_id", "organization_id");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd; the app role has no DELETE on any of the seven.
ALTER TABLE "commercial_authorization" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_authorization" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_authorization_org" ON "commercial_authorization";--> statement-breakpoint
CREATE POLICY "commercial_authorization_org" ON "commercial_authorization" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_claim" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_claim_org" ON "commercial_claim";--> statement-breakpoint
CREATE POLICY "commercial_claim_org" ON "commercial_claim" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_claim_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_claim_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_claim_line_org" ON "commercial_claim_line";--> statement-breakpoint
CREATE POLICY "commercial_claim_line_org" ON "commercial_claim_line" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_claim_state_history_org" ON "commercial_claim_state_history";--> statement-breakpoint
CREATE POLICY "commercial_claim_state_history_org" ON "commercial_claim_state_history" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_validation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_validation_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_validation_run_org" ON "commercial_validation_run";--> statement-breakpoint
CREATE POLICY "commercial_validation_run_org" ON "commercial_validation_run" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_validation_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_validation_result" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_validation_result_org" ON "commercial_validation_result";--> statement-breakpoint
CREATE POLICY "commercial_validation_result_org" ON "commercial_validation_result" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_validation_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_validation_override" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_validation_override_org" ON "commercial_validation_override";--> statement-breakpoint
CREATE POLICY "commercial_validation_override_org" ON "commercial_validation_override" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Grants: assembly output is append-only. Only the lifecycle columns of a claim and the status / end date of an authorization move.
GRANT SELECT, INSERT ON "commercial_authorization" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "effective_to", "updated_at") ON "commercial_authorization" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_claim" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("state", "latest_validation_run_id", "ready_at", "updated_at") ON "commercial_claim" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_claim_line" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_claim_state_history" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_validation_run" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_validation_result" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_validation_override" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_authorization" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_claim" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_claim_line" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_claim_state_history" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_validation_run" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_validation_result" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_validation_override" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). Free text and clinical content are scrubbed; no member id or MBI is stored at all.
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_authorization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['authorization_number']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_authorization.' || lower(TG_OP), 'commercial_authorization', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_authorization() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_authorization" ON commercial_authorization;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_authorization" AFTER INSERT OR UPDATE OR DELETE ON commercial_authorization FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_authorization();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['diagnoses','attending_first_name','attending_last_name']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_claim.' || lower(TG_OP), 'commercial_claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_claim() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_claim" ON commercial_claim;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_claim" AFTER INSERT OR UPDATE OR DELETE ON commercial_claim FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_claim();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_claim_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_claim_line.' || lower(TG_OP), 'commercial_claim_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_claim_line() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_claim_line" ON commercial_claim_line;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_claim_line" AFTER INSERT OR UPDATE OR DELETE ON commercial_claim_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_claim_line();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_claim_state_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_claim_state_history.' || lower(TG_OP), 'commercial_claim_state_history', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_claim_state_history() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_claim_state_history" ON commercial_claim_state_history;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_claim_state_history" AFTER INSERT OR UPDATE OR DELETE ON commercial_claim_state_history FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_claim_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_validation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_validation_run.' || lower(TG_OP), 'commercial_validation_run', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_validation_run() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_validation_run" ON commercial_validation_run;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_validation_run" AFTER INSERT OR UPDATE OR DELETE ON commercial_validation_run FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_validation_run();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_validation_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['evidence']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_validation_result.' || lower(TG_OP), 'commercial_validation_result', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_validation_result() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_validation_result" ON commercial_validation_result;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_validation_result" AFTER INSERT OR UPDATE OR DELETE ON commercial_validation_result FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_validation_result();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_validation_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_validation_override.' || lower(TG_OP), 'commercial_validation_override', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_validation_override() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_validation_override" ON commercial_validation_override;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_validation_override" AFTER INSERT OR UPDATE OR DELETE ON commercial_validation_override FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_validation_override();
