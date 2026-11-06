-- compat: expand
-- M12: the DoseSpot clinic each tenant registered (tenant onboarding slice 4; ADR-0110). Until now ChartWarden bound DoseSpot
-- per tenant only through the DOSESPOT_TENANT_CONFIGS environment map, read once at boot. Now every tenant has its own row:
-- its DoseSpot environment, clinic id, service clinician and a SEALED credential, and where the registration is in
-- draft -> registered -> verified -> active. One row per organization.
--
--   environment  sandbox | production. It names a platform-held https host, NEVER a URL: a URL a tenant (or an operator for
--                it) could type would let the clinic key and PHI be sent to any server. Production additionally needs the
--                platform flag DOSESPOT_PRODUCTION_ENABLED at activation (the service checks it; a CHECK cannot read env).
--   status       draft       saved, incomplete (wizard save-and-resume): nothing is sent.
--                registered  clinic id, service clinician and credential all present; not yet tested.
--                verified    a connection test passed (DoseSpot accepted the credential), or an `active` registration was
--                            deactivated (the credential is unchanged, so no new test is owed).
--                active      in use: transmission, patient sync and status polling run. Only `active` is ever served.
--                ANY change to environment, clinic, clinician or credential puts the row back to `registered` (or `draft`
--                while incomplete) and clears what the old credential earned; the CHECKs make a half-state impossible.
--   secret_*     the clinic key (and Subscription-Key when the tenant has its own), sealed as ONE JSON envelope under the
--                tenant's key-ring DEK (AES-256-GCM; AAD binds organization, environment and clinic). `secret_dek_ref` is the
--                key-ring DEK version it was sealed with. Write-only: no read path returns it, and the audit trigger records
--                only THAT it changed (`secret_changed` in the audit context: the scrubbed before/after cannot show a swap).
--   verified_* / last_test_*  how and when the connection test ran: a no-PHI token mint, outcome ok | credential_rejected |
--                unreachable. A failed test records its outcome and leaves the status where it was.
--   no epcs column  EPCS stays under the D18 certification gate (ADR-0019 / ADR-006); no write path here can switch it on.
--
-- Tenant-scoped on organization_id. RLS ENABLE + FORCE: the app role reads and writes only its own org's row. Platform
-- operators write through the tenant's own scope (the app pool under the target org's app.org_id, the M34 onboarding-data
-- pattern), so no platform-carrier grant exists. No DELETE; no UPDATE of the id or the organization. The M4 write-audit trigger
-- names the actor (app.user_id: the operator on a platform write) and scrubs secret_cipher.
-- Boot reads nothing here: a tenant with no row keeps the env fallback (the demo tenant); a tenant WITH a row is served by
-- the row alone.

CREATE TABLE IF NOT EXISTS "dosespot_clinic_registration" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "environment" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "clinic_id" text,
  "service_clinician_id" text,
  "secret_cipher" text,
  "secret_dek_ref" text,
  "registered_at" timestamptz,
  "registered_by_membership_id" uuid,
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
  CONSTRAINT "dosespot_clinic_registration_org_uq" UNIQUE ("organization_id"),
  CONSTRAINT "dosespot_clinic_registration_environment_ck" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "dosespot_clinic_registration_status_ck" CHECK ("status" IN ('draft', 'registered', 'verified', 'active')),
  CONSTRAINT "dosespot_clinic_registration_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "dosespot_clinic_registration_clinic_id_ck" CHECK (
    "clinic_id" IS NULL OR "clinic_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "dosespot_clinic_registration_clinician_id_ck" CHECK (
    "service_clinician_id" IS NULL OR "service_clinician_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "dosespot_clinic_registration_secret_ck" CHECK (("secret_cipher" IS NULL) = ("secret_dek_ref" IS NULL)),
  CONSTRAINT "dosespot_clinic_registration_secret_len_ck" CHECK (
    "secret_cipher" IS NULL OR char_length("secret_cipher") BETWEEN 1 AND 8192),
  CONSTRAINT "dosespot_clinic_registration_test_outcome_ck" CHECK (
    "last_test_outcome" IS NULL OR "last_test_outcome" IN ('ok', 'credential_rejected', 'unreachable')),
  -- What each status has earned. A draft carries nothing past the fields it was saved with; every later status has a complete
  -- credential set and the timestamps of how it got there; `active` also names who activated it.
  CONSTRAINT "dosespot_clinic_registration_state_ck" CHECK (
    ("status" = 'draft' AND "registered_at" IS NULL AND "registered_by_membership_id" IS NULL
       AND "verified_at" IS NULL AND "verified_by_membership_id" IS NULL
       AND "activated_at" IS NULL AND "activated_by_membership_id" IS NULL)
    OR ("status" IN ('registered', 'verified', 'active')
       AND "clinic_id" IS NOT NULL AND "service_clinician_id" IS NOT NULL AND "secret_cipher" IS NOT NULL
       AND "registered_at" IS NOT NULL AND "registered_by_membership_id" IS NOT NULL)
  ),
  CONSTRAINT "dosespot_clinic_registration_verified_ck" CHECK (
    ("status" IN ('draft', 'registered') AND "verified_at" IS NULL AND "verified_by_membership_id" IS NULL
       AND "activated_at" IS NULL AND "activated_by_membership_id" IS NULL)
    OR ("status" = 'verified' AND "verified_at" IS NOT NULL AND "verified_by_membership_id" IS NOT NULL
       AND "activated_at" IS NULL AND "activated_by_membership_id" IS NULL)
    OR ("status" = 'active' AND "verified_at" IS NOT NULL AND "verified_by_membership_id" IS NOT NULL
       AND "activated_at" IS NOT NULL AND "activated_by_membership_id" IS NOT NULL)
  )
);--> statement-breakpoint

ALTER TABLE "dosespot_clinic_registration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dosespot_clinic_registration" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "dosespot_clinic_registration_org" ON "dosespot_clinic_registration";--> statement-breakpoint
CREATE POLICY "dosespot_clinic_registration_org" ON "dosespot_clinic_registration" FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "dosespot_clinic_registration" TO chartwarden_app;--> statement-breakpoint
-- UPDATE is column-level: the organization and the row id can never be rewritten.
GRANT UPDATE ("environment", "status", "clinic_id", "service_clinician_id", "secret_cipher", "secret_dek_ref",
  "registered_at", "registered_by_membership_id", "verified_at", "verified_by_membership_id", "last_test_at",
  "last_test_outcome", "activated_at", "activated_by_membership_id", "set_by_membership_id", "version", "updated_at")
  ON "dosespot_clinic_registration" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "dosespot_clinic_registration" TO chartwarden_admin;--> statement-breakpoint

-- M04 write-audit: the registration decides where the tenant's prescriptions (PHI) go, so every change is compliance-retained.
-- The sealed secret is never copied into the audit row (audit_scrub replaces it with the change marker), and the marker is the
-- same on both sides, so a swapped credential would be invisible: the context therefore carries `secret_changed`.
CREATE OR REPLACE FUNCTION audit_phi_write_dosespot_clinic_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['secret_cipher']::text[]; v_secret_changed boolean;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  v_secret_changed := CASE TG_OP
    WHEN 'INSERT' THEN NEW.secret_cipher IS NOT NULL
    WHEN 'UPDATE' THEN OLD.secret_cipher IS DISTINCT FROM NEW.secret_cipher
    ELSE OLD.secret_cipher IS NOT NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'dosespot_clinic_registration.' || lower(TG_OP), 'dosespot_clinic_registration', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('secret_changed', v_secret_changed), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dosespot_clinic_registration() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_dosespot_clinic_registration" ON dosespot_clinic_registration;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dosespot_clinic_registration" AFTER INSERT OR UPDATE OR DELETE ON dosespot_clinic_registration FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dosespot_clinic_registration();
