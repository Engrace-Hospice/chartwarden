-- compat: expand
-- Slice 2 (tenant pricing) - three tenant-scoped tables, all SELECT-ONLY to the app role: a tenant reads its own contract, census and
-- statements but can never write what it is billed on. Every write goes through the platform carrier (M35's platform runner).
--
--   subscription_contract  the signed terms of a subscription on a census_banded plan: the plan VERSION it signed (the plan row is
--                          frozen once published, so the price cannot move under it), the billing service mode, who signed and why.
--   patient_census_daily   one row per org per UTC day: the active-patient count the `m35.patient-census` sweep read from M5's
--                          PatientCensusReader (the latest observation of the day wins). The average daily census is the mean of
--                          these. A count only: no patient id, pseudonym or name.
--   subscription_statement one row per subscription per calendar month: the inputs (staff, ADC, net collections), the price terms
--                          applied, both sides of the greater-of rule, and the total. `draft` while the month is open (recomputed,
--                          idempotently), `final` once closed; a final row is frozen except for the Stripe push columns.
-- Money is integer cents, rates integer basis points, ADC integer hundredths of a patient.

CREATE TABLE IF NOT EXISTS "subscription_contract" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"billing_service_mode" text DEFAULT 'none' NOT NULL,
	"contract_start_on" date NOT NULL,
	"signed_by_membership_id" uuid NOT NULL,
	"signed_reason" text NOT NULL,
	"order_form_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_contract_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscription_contract_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict,
	CONSTRAINT "subscription_contract_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict,
	CONSTRAINT "subscription_contract_subscription_uq" UNIQUE ("subscription_id"),
	CONSTRAINT "subscription_contract_mode_ck" CHECK ("billing_service_mode" IN ('none', 'billing_software', 'managed_billing')),
	CONSTRAINT "subscription_contract_reason_ck" CHECK (length(btrim("signed_reason")) BETWEEN 8 AND 1000),
	CONSTRAINT "subscription_contract_order_ref_ck" CHECK ("order_form_ref" IS NULL OR length("order_form_ref") <= 500)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_contract_org_ix" ON "subscription_contract" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_contract_plan_ix" ON "subscription_contract" ("plan_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "patient_census_daily" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"census_date" date NOT NULL,
	"active_patient_count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_census_daily_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "patient_census_daily_org_date_uq" UNIQUE ("organization_id", "census_date"),
	CONSTRAINT "patient_census_daily_count_ck" CHECK ("active_patient_count" >= 0)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscription_statement" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"period_year_month" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	-- inputs
	"staff_count" integer NOT NULL,
	"staff_count_basis" text NOT NULL,
	"adc_hundredths" integer NOT NULL,
	"adc_days_observed" integer NOT NULL,
	"adc_days_in_period" integer NOT NULL,
	"billing_service_mode" text NOT NULL,
	"net_collections_cents" bigint NOT NULL,
	"net_collections_remittance_count" integer NOT NULL,
	"net_collections_pending_count" integer NOT NULL,
	-- the price terms applied (copied from the plan version, so the statement explains itself)
	"per_user_price_cents" bigint NOT NULL,
	"band_min_adc" integer NOT NULL,
	"band_fee_cents" bigint NOT NULL,
	"billing_bps" integer NOT NULL,
	"minimum_monthly_cents" bigint,
	-- outputs
	"per_user_subtotal_cents" bigint NOT NULL,
	"platform_fee_cents" bigint NOT NULL,
	"platform_fee_basis" text NOT NULL,
	"billing_fee_cents" bigint NOT NULL,
	"one_time_fee_cents" bigint NOT NULL,
	"minimum_adjustment_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	-- the Stripe seam: nothing writes these until M35's Stripe subscription wiring exists (ADR-0108 D7 / slice 2 report)
	"stripe_usage_record_id" text,
	"stripe_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_statement_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscription_statement_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict,
	CONSTRAINT "subscription_statement_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict,
	CONSTRAINT "subscription_statement_period_uq" UNIQUE ("subscription_id", "period_year_month"),
	CONSTRAINT "subscription_statement_period_ck" CHECK ("period_year_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "period_end" > "period_start"),
	CONSTRAINT "subscription_statement_status_ck" CHECK ("status" IN ('draft', 'final')),
	CONSTRAINT "subscription_statement_finalized_ck" CHECK (("status" = 'final') = ("finalized_at" IS NOT NULL)),
	CONSTRAINT "subscription_statement_mode_ck" CHECK ("billing_service_mode" IN ('none', 'billing_software', 'managed_billing')),
	CONSTRAINT "subscription_statement_basis_ck" CHECK ("platform_fee_basis" IN ('per_user', 'census_band')),
	CONSTRAINT "subscription_statement_staff_basis_ck" CHECK ("staff_count_basis" IN ('identity_filtered', 'ledger_unfiltered')),
	CONSTRAINT "subscription_statement_counts_ck" CHECK (
		"staff_count" >= 0 AND "adc_hundredths" >= 0 AND "adc_days_observed" >= 0 AND "adc_days_in_period" > 0
		AND "adc_days_observed" <= "adc_days_in_period" AND "net_collections_remittance_count" >= 0 AND "net_collections_pending_count" >= 0),
	CONSTRAINT "subscription_statement_money_ck" CHECK (
		"per_user_price_cents" >= 0 AND "band_fee_cents" >= 0 AND "billing_fee_cents" >= 0 AND "one_time_fee_cents" >= 0
		AND "minimum_adjustment_cents" >= 0 AND "per_user_subtotal_cents" >= 0 AND "platform_fee_cents" >= 0),
	CONSTRAINT "subscription_statement_platform_fee_ck" CHECK ("platform_fee_cents" = GREATEST("per_user_subtotal_cents", "band_fee_cents")),
	CONSTRAINT "subscription_statement_total_ck" CHECK (
		"total_cents" = "platform_fee_cents" + "billing_fee_cents" + "one_time_fee_cents" + "minimum_adjustment_cents")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_statement_org_period_ix" ON "subscription_statement" ("organization_id", "period_year_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_statement_plan_ix" ON "subscription_statement" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_statement_unposted_ix" ON "subscription_statement" ("period_end") WHERE "status" = 'final' AND "stripe_posted_at" IS NULL;--> statement-breakpoint

-- RLS: a tenant reads its own rows and writes none.
ALTER TABLE "subscription_contract" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_contract" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "subscription_contract_org_read" ON "subscription_contract";--> statement-breakpoint
CREATE POLICY "subscription_contract_org_read" ON "subscription_contract"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "subscription_contract" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "subscription_contract" TO chartwarden_admin;--> statement-breakpoint

ALTER TABLE "patient_census_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_census_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "patient_census_daily_org_read" ON "patient_census_daily";--> statement-breakpoint
CREATE POLICY "patient_census_daily_org_read" ON "patient_census_daily"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "patient_census_daily" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "patient_census_daily" TO chartwarden_admin;--> statement-breakpoint

ALTER TABLE "subscription_statement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_statement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "subscription_statement_org_read" ON "subscription_statement";--> statement-breakpoint
CREATE POLICY "subscription_statement_org_read" ON "subscription_statement"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "subscription_statement" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "subscription_statement" TO chartwarden_admin;--> statement-breakpoint

-- The contract must point at a PUBLISHED census_banded plan (so the price it signed is frozen) that is the subscription's own
-- plan, in the subscription's own organisation.
CREATE OR REPLACE FUNCTION subscription_contract_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan p WHERE p.id = NEW.plan_id AND p.tier = 'census_banded' AND p.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'subscription_contract: the plan must be a published census_banded version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription s WHERE s.id = NEW.subscription_id AND s.plan_id = NEW.plan_id
                 AND s.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'subscription_contract: it must name the subscription''s own plan and organization' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.subscription_id, NEW.plan_id, NEW.organization_id, NEW.contract_start_on, NEW.signed_by_membership_id)
     IS DISTINCT FROM (OLD.subscription_id, OLD.plan_id, OLD.organization_id, OLD.contract_start_on, OLD.signed_by_membership_id) THEN
    RAISE EXCEPTION 'subscription_contract: only the billing service mode can change after signing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "subscription_contract_guard" BEFORE INSERT OR UPDATE ON "subscription_contract"
  FOR EACH ROW EXECUTE FUNCTION subscription_contract_guard();--> statement-breakpoint

-- A final statement is frozen: only the Stripe push columns (and updated_at) may be written after it closes.
CREATE OR REPLACE FUNCTION subscription_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final'
     AND (to_jsonb(NEW) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'stripe_usage_record_id' - 'stripe_posted_at' - 'updated_at') THEN
    RAISE EXCEPTION 'subscription_statement: a final statement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "subscription_statement_guard" BEFORE UPDATE ON "subscription_statement"
  FOR EACH ROW EXECUTE FUNCTION subscription_statement_guard();--> statement-breakpoint

-- The contract's row audit is a SCRUBBING variant (the audit_phi_write_<table> shape, 1250): audit_event is tenant-readable
-- (GET /api/v1/audit/events), and the generic trigger would copy the operator's membership id, the free-text signing reason and
-- the order-form reference into the tenant's own audit trail, which is exactly what the tenant surface of the contract hides. The
-- columns are recorded as CHANGED, never copied. (Dropping the row trigger instead would lose the database-level trail of an
-- insert / update / delete of a contract; the operator, tenant and reason stay in the PLATFORM-scoped structured audit row the
-- signing writes in the same transaction, which a tenant cannot read.)
CREATE OR REPLACE FUNCTION audit_phi_write_subscription_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['signed_by_membership_id', 'signed_reason', 'order_form_ref'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
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
ALTER FUNCTION audit_phi_write_subscription_contract() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "subscription_contract_audit" AFTER INSERT OR UPDATE OR DELETE ON subscription_contract
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_subscription_contract();--> statement-breakpoint
CREATE TRIGGER "patient_census_daily_audit" AFTER INSERT OR UPDATE OR DELETE ON patient_census_daily
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "subscription_statement_audit" AFTER INSERT OR UPDATE OR DELETE ON subscription_statement
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();
