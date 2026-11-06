-- compat: contract
-- DECLARED contract, not expand: the last statement DEACTIVATES the live starter / professional / enterprise plans (it retires the flat
-- tiers), so the previous release, which still offers them to a new tenant, no longer finds an offered flat plan on the new schema.
-- Slice 2 (tenant pricing) - the contracted plan model on `plan`, its census bands, and the retirement of the flat tiers.
--
-- Monthly platform fee = the GREATER of (active staff x per_user_price_cents) and the flat fee of the census band the average
-- daily census falls in. Billing = a percentage of net collections (billing_software_bps for a tenant that bills in ChartWarden,
-- managed_billing_bps when ChartWarden bills for it; a tenant that bills outside pays none). Every price is a column on the plan:
-- nothing is hardcoded. Money is integer cents, rates are integer basis points.
--
-- VERSIONING. A plan row is one VERSION: (family_slug, version), slug = '<family_slug>-v<version>'. A draft (published_at IS NULL)
-- is editable; publishing freezes its prices and bands for good (the guard trigger below), so a subscription that points at the
-- row keeps the price it signed. A price change is a NEW version (supersedes_plan_id) that the next tenant signs; the old row is
-- archived (is_active = false, deprecated_at), never edited. The retired starter / professional / enterprise rows carry none of
-- the new columns and are not touched by the guards.
--
-- Cross-column rules ride a trigger, not ADD CONSTRAINT (a new constraint on a live table is enforced against the previous
-- release's writes, which arch:migration-compat reads as contracting); the previous release cannot write tier 'census_banded'.
ALTER TABLE "plan"
  ADD COLUMN "family_slug" text
    CONSTRAINT "plan_family_slug_ck" CHECK ("family_slug" IS NULL OR "family_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD COLUMN "version" integer NOT NULL DEFAULT 1
    CONSTRAINT "plan_version_ck" CHECK ("version" >= 1),
  ADD COLUMN "supersedes_plan_id" uuid
    CONSTRAINT "plan_supersedes_plan_id_fk" REFERENCES "plan"("id") ON DELETE RESTRICT,
  ADD COLUMN "per_user_price_cents" bigint
    CONSTRAINT "plan_per_user_price_ck" CHECK ("per_user_price_cents" IS NULL OR "per_user_price_cents" >= 0),
  ADD COLUMN "billing_software_bps" integer
    CONSTRAINT "plan_billing_software_bps_ck" CHECK ("billing_software_bps" IS NULL OR "billing_software_bps" BETWEEN 0 AND 10000),
  ADD COLUMN "managed_billing_bps" integer
    CONSTRAINT "plan_managed_billing_bps_ck" CHECK ("managed_billing_bps" IS NULL OR "managed_billing_bps" BETWEEN 0 AND 10000),
  ADD COLUMN "contract_term_months" integer
    CONSTRAINT "plan_contract_term_ck" CHECK ("contract_term_months" IS NULL OR "contract_term_months" >= 1),
  ADD COLUMN "implementation_fee_cents" bigint
    CONSTRAINT "plan_implementation_fee_ck" CHECK ("implementation_fee_cents" IS NULL OR "implementation_fee_cents" >= 0),
  ADD COLUMN "minimum_monthly_cents" bigint
    CONSTRAINT "plan_minimum_monthly_ck" CHECK ("minimum_monthly_cents" IS NULL OR "minimum_monthly_cents" >= 0),
  ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint

-- One row per census band of a plan. A band is a THRESHOLD: it starts at min_adc patients and runs until the next band starts,
-- so bands cannot overlap or leave a gap. PLATFORM-SHARED (no organization_id by design: the same offer for every tenant), the
-- `plan` shape: read-all to the app role, written only by the platform carrier / chartwarden_admin.
CREATE TABLE IF NOT EXISTS "plan_census_band" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"min_adc" integer NOT NULL,
	"monthly_fee_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_census_band_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "plan_census_band_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict,
	CONSTRAINT "plan_census_band_plan_min_adc_uq" UNIQUE ("plan_id", "min_adc"),
	CONSTRAINT "plan_census_band_min_adc_ck" CHECK ("min_adc" >= 0),
	CONSTRAINT "plan_census_band_fee_ck" CHECK ("monthly_fee_cents" >= 0)
);--> statement-breakpoint
ALTER TABLE "plan_census_band" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_census_band" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "plan_census_band_read" ON "plan_census_band";--> statement-breakpoint
CREATE POLICY "plan_census_band_read" ON "plan_census_band" FOR SELECT TO chartwarden_app USING (true);--> statement-breakpoint
GRANT SELECT ON "plan_census_band" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "plan_census_band" TO chartwarden_admin;--> statement-breakpoint

-- The guard on `plan`. census_banded rows only; the retired tiers pass through untouched (and may not carry the new columns).
-- A plan's tier is part of what freezes: the published-version freeze below keys on OLD.tier, so a row that could leave census_banded
-- (nulling its prices and its published_at in the same UPDATE) and come back as a draft would be re-priced and re-published under
-- the subscriptions that signed it. So a census_banded row never changes tier, a published row never goes back to a draft, and a
-- flat row that subscriptions already use never becomes census_banded.
CREATE OR REPLACE FUNCTION plan_census_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tier = 'census_banded' AND NEW.tier <> OLD.tier THEN
      RAISE EXCEPTION 'plan %: a census_banded plan cannot change tier', OLD.slug USING ERRCODE = '23514';
    END IF;
    IF OLD.tier = 'census_banded' AND OLD.published_at IS NOT NULL AND NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'plan %: a published version cannot go back to a draft', OLD.slug USING ERRCODE = '23514';
    END IF;
    IF OLD.tier <> 'census_banded' AND NEW.tier = 'census_banded'
       AND EXISTS (SELECT 1 FROM subscription s WHERE s.plan_id = OLD.id) THEN
      RAISE EXCEPTION 'plan %: a plan that subscriptions use cannot become census_banded', OLD.slug USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.tier <> 'census_banded' THEN
    IF NEW.family_slug IS NOT NULL OR NEW.per_user_price_cents IS NOT NULL OR NEW.billing_software_bps IS NOT NULL
       OR NEW.managed_billing_bps IS NOT NULL OR NEW.contract_term_months IS NOT NULL
       OR NEW.implementation_fee_cents IS NOT NULL OR NEW.minimum_monthly_cents IS NOT NULL OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'plan %: only a census_banded plan carries the contracted pricing columns', NEW.slug USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.tier = 'census_banded' AND OLD.published_at IS NOT NULL THEN
    -- A published version is frozen: only its name, description, offered/archived state, validity end and Stripe ids may change.
    IF ROW(NEW.slug, NEW.tier, NEW.cadence, NEW.base_price_cents, NEW.currency_code, NEW.trial_period_days, NEW.valid_from,
           NEW.family_slug, NEW.version, NEW.supersedes_plan_id, NEW.per_user_price_cents, NEW.billing_software_bps,
           NEW.managed_billing_bps, NEW.contract_term_months, NEW.implementation_fee_cents, NEW.minimum_monthly_cents, NEW.published_at)
       IS DISTINCT FROM
       ROW(OLD.slug, OLD.tier, OLD.cadence, OLD.base_price_cents, OLD.currency_code, OLD.trial_period_days, OLD.valid_from,
           OLD.family_slug, OLD.version, OLD.supersedes_plan_id, OLD.per_user_price_cents, OLD.billing_software_bps,
           OLD.managed_billing_bps, OLD.contract_term_months, OLD.implementation_fee_cents, OLD.minimum_monthly_cents, OLD.published_at) THEN
      RAISE EXCEPTION 'plan %: a published version is frozen; create a new version to change a price', OLD.slug USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.family_slug IS NULL OR NEW.slug <> NEW.family_slug || '-v' || NEW.version THEN
    RAISE EXCEPTION 'plan %: a census_banded plan slug is <family_slug>-v<version>', NEW.slug USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'plan %: a plan is created as a draft and published afterwards (its bands come first)', NEW.slug USING ERRCODE = '23514';
  END IF;
  IF NEW.is_active AND NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'plan %: a draft cannot be offered; publish it', NEW.slug USING ERRCODE = '23514';
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    IF NEW.per_user_price_cents IS NULL OR NEW.billing_software_bps IS NULL OR NEW.managed_billing_bps IS NULL
       OR NEW.contract_term_months IS NULL OR NEW.implementation_fee_cents IS NULL THEN
      RAISE EXCEPTION 'plan %: every price must be set before it is published', NEW.slug USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM plan_census_band b WHERE b.plan_id = NEW.id AND b.min_adc = 0) THEN
      RAISE EXCEPTION 'plan %: a band that starts at 0 patients is required before it is published', NEW.slug USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "plan_census_guard" BEFORE INSERT OR UPDATE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION plan_census_guard();--> statement-breakpoint

-- A published census_banded version is never deleted: subscriptions and statements point at the price it froze. (A draft may be
-- deleted by an administrator; a flat plan is not covered.)
CREATE OR REPLACE FUNCTION plan_census_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tier = 'census_banded' AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'plan %: a published version cannot be deleted', OLD.slug USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER "plan_census_delete_guard" BEFORE DELETE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION plan_census_delete_guard();--> statement-breakpoint

-- Bands of a published plan are frozen with it.
-- A band never moves between plans: re-pointing a band of a draft at a published plan (or the reverse) would rewrite a published
-- price list without touching the plan row, so the guard judges the band's OLD plan and refuses a plan_id change outright.
CREATE OR REPLACE FUNCTION plan_census_band_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    RAISE EXCEPTION 'plan_census_band: a band cannot move to another plan' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN target := OLD.plan_id; ELSE target := NEW.plan_id; END IF;
  IF EXISTS (SELECT 1 FROM plan p WHERE p.id = target AND p.published_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM plan p WHERE p.id = target AND p.tier = 'census_banded') THEN
    RAISE EXCEPTION 'plan_census_band: the bands of a published (or non-census_banded) plan cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "plan_census_band_guard" BEFORE INSERT OR UPDATE OR DELETE ON "plan_census_band"
  FOR EACH ROW EXECUTE FUNCTION plan_census_band_guard();--> statement-breakpoint
CREATE TRIGGER "plan_census_band_audit" AFTER INSERT OR UPDATE OR DELETE ON plan_census_band
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

-- Retire the flat tiers: no new tenant is offered one. The rows, their meters and every subscription already on one stay
-- readable and keep running (usage aggregation reads plan_meter by plan id, not by is_active).
UPDATE "plan"
   SET "is_active" = false, "deprecated_at" = COALESCE("deprecated_at", now()), "updated_at" = now()
 WHERE "tier" IN ('starter', 'professional', 'enterprise')
   AND "is_active" = true;
