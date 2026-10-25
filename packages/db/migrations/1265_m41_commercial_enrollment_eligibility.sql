-- M41 Billing - Commercial, enrollment and eligibility (issue #724, ADR-0100 D4, D5, D9).
--
--   commercial_payer_plan (altered)  two per-plan policy columns: what stale or missing eligibility does to claim validation
--                                    ('warn' by default, 'block' by opt-in) and how many days make a check stale (30 by default,
--                                    OUR default, not a payer fact).
--   commercial_payer_enrollment      a provider entity's enrollment with a payer on a clearinghouse (ADR-0053 D8). Only
--                                    status 'enrolled', in effect on the day, lets a send through. NO PHI.
--   commercial_eligibility_check     one 270/271 exchange through the platform ClearinghouseTransport. Append-only. PHI-adjacent
--                                    (it names a patient), so it carries the three-column tenancy rule. It holds the OUTCOME and
--                                    AS-OF DATE only: never the member id, never the 271 body. The member id lives in M5's
--                                    patient_payer and is read transiently for the one call.
--
-- Closed sets are text + CHECK mirrored in packages/types/src/commercial-billing.ts (commercial-billing.test.ts fails on drift).
-- Canonical app.org_id RLS, FORCEd, no DELETE for the app role. Idempotent on purpose (the 1116/1117 renumber lesson).

ALTER TABLE "commercial_payer_plan"
  ADD COLUMN IF NOT EXISTS "eligibility_staleness_policy" text NOT NULL DEFAULT 'warn' CHECK ("eligibility_staleness_policy" IN ('warn','block'));--> statement-breakpoint
ALTER TABLE "commercial_payer_plan"
  ADD COLUMN IF NOT EXISTS "eligibility_max_age_days" smallint NOT NULL DEFAULT 30 CHECK ("eligibility_max_age_days" BETWEEN 1 AND 365);--> statement-breakpoint
GRANT UPDATE ("eligibility_staleness_policy", "eligibility_max_age_days") ON "commercial_payer_plan" TO chartwarden_app;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_payer_enrollment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL, -- M1 provider entity (logical FK)
  "payer_id" uuid NOT NULL, -- M40 canonical payer (logical FK; checked by trigger below)
  -- the platform clearinghouse binding's key (ADR-0053), the same label commercial_payer_route.clearinghouse_key carries
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "status" text NOT NULL DEFAULT 'not_enrolled' CHECK ("status" IN ('not_enrolled','pending','enrolled','suspended')),
  "effective_from" date NOT NULL,
  "effective_to" date,
  -- an opaque reference to the evidence (a document id, a ticket number); never free text, never a person
  "evidence_ref" text CHECK ("evidence_ref" IS NULL OR "evidence_ref" ~ '^[A-Za-z0-9._:/#-]{1,200}$'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_payer_enrollment_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "commercial_payer_enrollment_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =, "provider_entity_id" WITH =, "payer_id" WITH =, "clearinghouse_key" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_payer_enrollment_org_ix" ON "commercial_payer_enrollment" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_payer_enrollment_lookup_ix" ON "commercial_payer_enrollment" ("organization_id", "provider_entity_id", "payer_id", "clearinghouse_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_eligibility_check" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL, -- logical FK (M1)
  "location_id" uuid, -- logical FK (M1); nullable: the check is made for the provider entity
  "patient_id" uuid NOT NULL, -- logical FK (M5)
  "plan_id" uuid NOT NULL,
  "patient_payer_id" uuid NOT NULL, -- the M5 coverage row the member id came from (an id, never the value)
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "clearinghouse_payer_id" text NOT NULL CHECK ("clearinghouse_payer_id" ~ '^[A-Za-z0-9._-]{1,40}$'),
  "service_date" date NOT NULL, -- the date the check was made for
  "outcome" text NOT NULL CHECK ("outcome" IN ('active','inactive','unknown')),
  "as_of_date" date NOT NULL, -- the date the clearinghouse says the answer is as of
  "request_id" uuid NOT NULL, -- the correlation id the clearinghouse call carried, so a vendor log joins to our audit trail
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  "checked_by_user_id" uuid NOT NULL,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_eligibility_check_plan_fk" FOREIGN KEY ("plan_id", "organization_id") REFERENCES "commercial_payer_plan"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_eligibility_check_idem_key" UNIQUE ("organization_id", "provider_entity_id", "idempotency_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_eligibility_check_org_ix" ON "commercial_eligibility_check" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_eligibility_check_patient_recent_ix" ON "commercial_eligibility_check" ("organization_id", "patient_id", "plan_id", "checked_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_eligibility_check_plan_ix" ON "commercial_eligibility_check" ("plan_id");--> statement-breakpoint

ALTER TABLE "commercial_payer_enrollment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_payer_enrollment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_payer_enrollment_org" ON "commercial_payer_enrollment";--> statement-breakpoint
CREATE POLICY "commercial_payer_enrollment_org" ON "commercial_payer_enrollment" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_eligibility_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_eligibility_check" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_eligibility_check_org" ON "commercial_eligibility_check";--> statement-breakpoint
CREATE POLICY "commercial_eligibility_check_org" ON "commercial_eligibility_check" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- An enrollment's anchor (provider entity, payer, clearinghouse) never changes: a different anchor is a different row. An
-- eligibility check is append-only: the app role can read and add, never change or remove.
GRANT SELECT, INSERT ON "commercial_payer_enrollment" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "effective_to", "evidence_ref", "updated_at") ON "commercial_payer_enrollment" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_payer_enrollment" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_eligibility_check" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_eligibility_check" TO chartwarden_admin;--> statement-breakpoint

-- An enrollment's payer must be an ACTIVE commercial (or other non-Medicare program) M40 payer: the plan guard from 1260, reused.
DROP TRIGGER IF EXISTS "trg_commercial_payer_enrollment_payer_guard" ON "commercial_payer_enrollment";--> statement-breakpoint
CREATE TRIGGER "trg_commercial_payer_enrollment_payer_guard" BEFORE INSERT ON "commercial_payer_enrollment" FOR EACH ROW EXECUTE FUNCTION m41_commercial_payer_plan_payer_guard();--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). Neither table holds free text, a member id or a 271 body, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_payer_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_payer_enrollment.' || lower(TG_OP), 'commercial_payer_enrollment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_payer_enrollment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_payer_enrollment" ON commercial_payer_enrollment;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_payer_enrollment" AFTER INSERT OR UPDATE OR DELETE ON commercial_payer_enrollment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_payer_enrollment();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_commercial_eligibility_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_eligibility_check.' || lower(TG_OP), 'commercial_eligibility_check', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_eligibility_check() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_eligibility_check" ON commercial_eligibility_check;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_eligibility_check" AFTER INSERT OR UPDATE OR DELETE ON commercial_eligibility_check FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_eligibility_check();--> statement-breakpoint

-- The five M41 permission keys (spec section 6). Read and write go to the billing roles that already run eligibility
-- (billing.eligibility.check) plus compliance_officer, administrator and org_admin; submit, override_validation and
-- manage_enrollment go to compliance_officer, administrator and org_admin only. New tenants get them from templates.ts
-- (administrator / org_admin through the catalog, compliance_officer explicitly). Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('commercial_billing.read', 'commercial_billing', 'read', 'billing', 'none', ''),
  ('commercial_billing.write', 'commercial_billing', 'write', 'billing', 'none', ''),
  ('commercial_billing.submit', 'commercial_claim', 'submit', 'billing', 'none', ''),
  ('commercial_billing.override_validation', 'commercial_validation_result', 'override', 'billing', 'none', ''),
  ('commercial_billing.manage_enrollment', 'commercial_payer_enrollment', 'manage', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
  CROSS JOIN (VALUES ('commercial_billing.read'), ('commercial_billing.write'), ('commercial_billing.submit'),
                     ('commercial_billing.override_validation'), ('commercial_billing.manage_enrollment')) AS k("key")
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", k."key"
  FROM "role_permission" rp
  CROSS JOIN (VALUES ('commercial_billing.read'), ('commercial_billing.write')) AS k("key")
 WHERE rp."permission_key" = 'billing.eligibility.check'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
