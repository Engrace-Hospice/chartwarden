-- compat: expand
-- M23: the clearinghouse each tenant chose (ADR-0053 amendment 2026-11-06; ADR-0108 repurposed). Until now ChartWarden bound
-- ONE clearinghouse for the whole platform (CLEARINGHOUSE_VENDOR); now every tenant chooses `stedi`, `claimmd` or `outside`
-- ("bills outside ChartWarden"), with its own sealed vendor credential. One row per organization.
--
--   vendor    stedi | claimmd | outside. `outside` carries no mode and no secret and is always `active` (nothing to verify).
--   mode      test | production: which vendor mode the credential opens (a `test` config reaches only the vendor's test mode).
--   status    draft (saved; nothing is sent) -> verified (the vendor connection was tested, or an operator attested it with
--             evidence) -> active (in use: claims and eligibility work is allowed). Any change to vendor, mode or secret
--             puts the row back to `draft` (the service does it; the CHECKs below make a half-state impossible).
--   secret_*  the vendor credential, AES-256-GCM sealed under the per-tenant key (the M23 MAC-credential envelope, its own
--             labels). Write-only: no read path returns it, and the audit trigger records only that it changed.
--   verification_*  how `verified` was reached: `connection_test` (a no-PHI vendor call) or `attested` (the operator's own
--             evidence note; used where the vendor has no safe probe). The evidence is a short note, never patient data.
--
-- Tenant-scoped on organization_id. RLS ENABLE + FORCE: the app role reads and writes only its own org's row. Platform
-- operators write through the tenant's own scope (the app pool under the target org's app.org_id, M34 onboarding-data
-- pattern), so no platform-carrier grant exists. No DELETE: switching to `outside` is an UPDATE. The M4 write-audit trigger
-- names the actor (app.user_id: the operator on a platform write) and scrubs secret_cipher.
-- Boot reads nothing here: a tenant with no row is "nothing chosen" (claims work refused, the platform env binding serves
-- only the orgs named in CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS).

CREATE TABLE IF NOT EXISTS "tenant_clearinghouse_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "vendor" text NOT NULL,
  "mode" text,
  "status" text NOT NULL DEFAULT 'draft',
  "secret_cipher" text,
  "secret_dek_version" integer,
  "verification_kind" text,
  "verification_evidence" text,
  "verified_at" timestamptz,
  "verified_by_membership_id" uuid,
  "last_test_at" timestamptz,
  "last_test_outcome" text,
  "activated_at" timestamptz,
  "activated_by_membership_id" uuid,
  "set_by_membership_id" uuid NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_clearinghouse_config_org_uq" UNIQUE ("organization_id"),
  CONSTRAINT "tenant_clearinghouse_config_vendor_ck" CHECK ("vendor" IN ('stedi', 'claimmd', 'outside')),
  CONSTRAINT "tenant_clearinghouse_config_status_ck" CHECK ("status" IN ('draft', 'verified', 'active')),
  CONSTRAINT "tenant_clearinghouse_config_mode_ck" CHECK ("mode" IS NULL OR "mode" IN ('test', 'production')),
  CONSTRAINT "tenant_clearinghouse_config_version_ck" CHECK ("version" >= 1),
  -- outside: no mode, no secret, nothing to verify, always active. A transmitting vendor always has a mode.
  CONSTRAINT "tenant_clearinghouse_config_outside_ck" CHECK (
    ("vendor" = 'outside' AND "mode" IS NULL AND "secret_cipher" IS NULL AND "status" = 'active'
       AND "verification_kind" IS NULL AND "verified_at" IS NULL)
    OR ("vendor" <> 'outside' AND "mode" IS NOT NULL)
  ),
  CONSTRAINT "tenant_clearinghouse_config_secret_ck" CHECK (("secret_cipher" IS NULL) = ("secret_dek_version" IS NULL)),
  CONSTRAINT "tenant_clearinghouse_config_secret_len_ck" CHECK ("secret_cipher" IS NULL OR char_length("secret_cipher") BETWEEN 1 AND 4096),
  -- A transmitting config past `draft` has its secret and the way it was verified; a `draft` carries neither verification nor activation.
  CONSTRAINT "tenant_clearinghouse_config_verified_ck" CHECK (
    "vendor" = 'outside'
    OR ("status" = 'draft' AND "verification_kind" IS NULL AND "verified_at" IS NULL AND "verified_by_membership_id" IS NULL
          AND "activated_at" IS NULL AND "activated_by_membership_id" IS NULL)
    OR ("status" = 'verified' AND "secret_cipher" IS NOT NULL AND "verification_kind" IS NOT NULL AND "verified_at" IS NOT NULL
          AND "verified_by_membership_id" IS NOT NULL AND "activated_at" IS NULL AND "activated_by_membership_id" IS NULL)
    OR ("status" = 'active' AND "secret_cipher" IS NOT NULL AND "verification_kind" IS NOT NULL AND "verified_at" IS NOT NULL
          AND "verified_by_membership_id" IS NOT NULL AND "activated_at" IS NOT NULL AND "activated_by_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "tenant_clearinghouse_config_verification_kind_ck" CHECK (
    "verification_kind" IS NULL OR "verification_kind" IN ('connection_test', 'attested')),
  CONSTRAINT "tenant_clearinghouse_config_evidence_ck" CHECK (
    "verification_evidence" IS NULL OR char_length(btrim("verification_evidence")) BETWEEN 1 AND 500),
  CONSTRAINT "tenant_clearinghouse_config_test_outcome_ck" CHECK (
    "last_test_outcome" IS NULL OR "last_test_outcome" IN ('ok', 'credential_rejected', 'unreachable'))
);--> statement-breakpoint

ALTER TABLE "tenant_clearinghouse_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_clearinghouse_config_org" ON "tenant_clearinghouse_config";--> statement-breakpoint
CREATE POLICY "tenant_clearinghouse_config_org" ON "tenant_clearinghouse_config" FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint
-- UPDATE is column-level: the organization and the row id can never be rewritten.
GRANT UPDATE ("vendor", "mode", "status", "secret_cipher", "secret_dek_version", "verification_kind", "verification_evidence",
  "verified_at", "verified_by_membership_id", "last_test_at", "last_test_outcome", "activated_at", "activated_by_membership_id",
  "set_by_membership_id", "version", "updated_at") ON "tenant_clearinghouse_config" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "tenant_clearinghouse_config" TO chartwarden_admin;--> statement-breakpoint

-- M04 write-audit: the config decides which vendor receives the tenant's claims (PHI), so every change is compliance-retained.
-- The sealed secret is never copied into the audit row (audit_scrub replaces it with the change marker).
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_clearinghouse_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['secret_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tenant_clearinghouse_config.' || lower(TG_OP), 'tenant_clearinghouse_config', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_clearinghouse_config() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_tenant_clearinghouse_config" ON tenant_clearinghouse_config;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_clearinghouse_config" AFTER INSERT OR UPDATE OR DELETE ON tenant_clearinghouse_config FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_clearinghouse_config();
