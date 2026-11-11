-- compat: expand
-- ADR-0053 amendment 2026-11-05, precondition 2 - platform-verified NPI ownership for the Claim.MD webhook intake (M23).
--
-- provider_npi_verification: "platform staff confirmed that provider entity P owns NPI N". A SEPARATE platform-written
-- record, not a column on provider_entity: a tenant `org.manage` user holds UPDATE on provider_entity and can register any
-- Luhn-valid NPI, so a flag there could be self-set. The row is keyed to the provider entity AND the NPI value verified;
-- the sweep routes an enrollment only when a live row matches the entity's CURRENT NPI, so changing the entity's NPI
-- stops it routing without anyone touching this table (it counts again only if the entity takes that NPI back and no
-- other entity has been verified for it since: verifying an NPI closes every other entity's live row for it). Revoking sets revoked_at/revoked_by; rows are never deleted.
--
-- Tenant-scoped on organization_id (no PHI). RLS ENABLE + FORCE with a SELECT-ONLY own-org policy and grant for
-- chartwarden_app (the subscription_addon posture, migration 1321): a tenant may read whether its entity is verified,
-- never write. Verify / revoke run only on the BYPASSRLS platform login (scripts/db/provision-runtime-roles.ts) through
-- M23's allowlisted, audited withPlatformContext. `provider_entity_id` is a LOGICAL FK (the M23 cross-module FK policy,
-- see clearinghouse_submission_attempt); the service resolves it from provider_entity before writing.
-- Write audit: the M1 baseline trigger; the after-image carries the operator's membership id (verified_by / revoked_by).

CREATE TABLE IF NOT EXISTS "provider_npi_verification" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"npi" text NOT NULL,
	"evidence" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by_membership_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_npi_verification_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "provider_npi_verification_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "provider_npi_verification_npi_ck" CHECK ("npi" ~ '^[0-9]{10}$'),
	CONSTRAINT "provider_npi_verification_evidence_ck" CHECK (length(btrim("evidence")) BETWEEN 1 AND 500),
	CONSTRAINT "provider_npi_verification_revoked_ck" CHECK (("revoked_at" IS NULL) = ("revoked_by_membership_id" IS NULL))
);--> statement-breakpoint
-- At most one live verification per provider entity (re-verifying a changed NPI revokes the stale one first).
CREATE UNIQUE INDEX IF NOT EXISTS "provider_npi_verification_live_uq" ON "provider_npi_verification" ("provider_entity_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_npi_verification_entity_ix" ON "provider_npi_verification" ("provider_entity_id", "npi", "verified_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_npi_verification_org_ix" ON "provider_npi_verification" ("organization_id");--> statement-breakpoint

ALTER TABLE "provider_npi_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_npi_verification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "provider_npi_verification_org_read" ON "provider_npi_verification";--> statement-breakpoint
CREATE POLICY "provider_npi_verification_org_read" ON "provider_npi_verification"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "provider_npi_verification" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "provider_npi_verification" TO chartwarden_admin;--> statement-breakpoint
-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    -- UPDATE is column-level (revocation only), the same list scripts/db/provision-runtime-roles.ts grants.
    GRANT SELECT, INSERT ON "provider_npi_verification" TO chartwarden_platform;
    GRANT UPDATE ("revoked_at", "revoked_by_membership_id", "updated_at") ON "provider_npi_verification" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

CREATE TRIGGER "provider_npi_verification_audit" AFTER INSERT OR UPDATE OR DELETE ON provider_npi_verification
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();
