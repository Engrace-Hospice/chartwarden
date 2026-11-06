-- compat: expand
-- ADR-0108 - the claims-billing add-on (M35). Two new tables; nothing existing changes.
--
--   * addon: the platform-owned add-on catalog, shaped like `plan` (D11: platform pricing, no tenant overlay). NO
--     organization_id BY DESIGN (check-tenancy NON_ORG_SCOPED). Read-all to chartwarden_app, writes only as
--     chartwarden_admin. Seeded with the one `claims_billing` row. unit_price_cents is NULL until platform ops sets a
--     price: Stripe charging is deferred (ADR-0108 D7), so nothing reads the price to bill yet.
--   * subscription_addon: which tenant subscription holds which add-on, and since when. Tenant-scoped on
--     organization_id (no PHI, so provider_entity_id/location_id do not attach - the M35 posture). RLS ENABLE + FORCE
--     with a SELECT-ONLY policy and grant for chartwarden_app: the entitlement reader runs on the tenant pool, but a
--     grant or cancel is written ONLY through M35's platform runner (the chartwarden_platform carrier), so a tenant can never grant
--     itself the add-on. At most one live (trialing/active) row per (organization, add-on).
-- Both carry the M1 baseline write-audit trigger: ids, statuses, instants and the operator's grant reason only.
-- The nullable stripe_* columns are placeholders for the deferred Stripe subscription-item wiring.

CREATE TABLE IF NOT EXISTS "addon" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"entitlement_key" text NOT NULL,
	"meter_event_type" "usage_event_type" NOT NULL,
	"unit_price_cents" bigint,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stripe_product_id" text,
	"stripe_price_id" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addon_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "addon_unit_price_ck" CHECK ("unit_price_cents" IS NULL OR "unit_price_cents" >= 0),
	CONSTRAINT "addon_validity_ck" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "addon_slug_uq" ON "addon" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "addon_entitlement_key_uq" ON "addon" ("entitlement_key");--> statement-breakpoint

INSERT INTO "addon" ("slug", "name", "description", "entitlement_key", "meter_event_type")
VALUES ('claims_billing', 'Claims billing',
        'Medicare, Medicaid and commercial claim submission, eligibility checks, DDE work and reopenings. Priced per active patient per month.',
        'claims_billing', 'billing_addon_patient')
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscription_addon" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"granted_by_membership_id" uuid,
	"grant_reason" text NOT NULL,
	"stripe_subscription_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_addon_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscription_addon_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict,
	CONSTRAINT "subscription_addon_addon_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addon"("id") ON DELETE restrict,
	CONSTRAINT "subscription_addon_status_ck" CHECK ("status" IN ('trialing', 'active', 'canceled')),
	CONSTRAINT "subscription_addon_trial_ck" CHECK ("status" <> 'trialing' OR "trial_ends_at" IS NOT NULL),
	CONSTRAINT "subscription_addon_canceled_ck" CHECK (("status" = 'canceled') = ("canceled_at" IS NOT NULL)),
	CONSTRAINT "subscription_addon_reason_ck" CHECK (length(btrim("grant_reason")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_addon_one_live_uq" ON "subscription_addon" ("organization_id", "addon_id")
  WHERE "status" IN ('trialing', 'active');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_addon_org_ix" ON "subscription_addon" ("organization_id", "addon_id", "started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_addon_subscription_ix" ON "subscription_addon" ("subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_addon_addon_ix" ON "subscription_addon" ("addon_id");--> statement-breakpoint

-- RLS + grants. addon: platform catalog (the `plan` shape). subscription_addon: tenant read-only.
ALTER TABLE "addon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "addon" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "addon_read" ON "addon";--> statement-breakpoint
CREATE POLICY "addon_read" ON "addon" FOR SELECT TO chartwarden_app USING (true);--> statement-breakpoint
GRANT SELECT ON "addon" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "addon" TO chartwarden_admin;--> statement-breakpoint
ALTER TABLE "subscription_addon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_addon" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "subscription_addon_org_read" ON "subscription_addon";--> statement-breakpoint
CREATE POLICY "subscription_addon_org_read" ON "subscription_addon"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "subscription_addon" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "subscription_addon" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit (the M35 baseline trigger; created after the seed so the migration's own insert is not an operator act).
CREATE TRIGGER "addon_audit" AFTER INSERT OR UPDATE OR DELETE ON addon
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "subscription_addon_audit" AFTER INSERT OR UPDATE OR DELETE ON subscription_addon
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();
