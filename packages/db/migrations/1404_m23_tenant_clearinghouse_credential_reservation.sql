-- compat: contract
-- M23 tenant clearinghouse (owner decision 2026-11-08, security review of 1403): a credential a tenant sealed STAYS reserved to
-- that tenant until a platform operator releases it. 1403's unique index sits on the config row, so the slot freed the moment the
-- tenant switched to `outside` or rotated to a new key: a sister organization could then seal the old key and pull the first
-- tenant's late acknowledgments and remittances. This table is the slot instead:
--
--   one row per (organization, credential) ever sealed: the vendor and the keyed fingerprint (HMAC-SHA256 under a key derived from
--   the credential KEK, never a plain hash; 1403). The partial unique index below spans organizations and holds every UNRELEASED
--   row, so a second organization's save fails with a unique violation the service maps to 409 CLEARINGHOUSE_ACCOUNT_IN_USE. RLS
--   hides the other organization's row; the index is checked regardless.
--   released_*  set only by the platform-ops release action (tenant_clearinghouse.release_credential_platform: a fresh step-up, a
--   human actor, a reason, an audit row), which never releases the tenant's CURRENT credential. A released row is final.
--
-- Only the credential is reserved, not the vendor account: a vendor that issues several keys for one account is not caught here.
-- tenant_clearinghouse_config.credential_fingerprint (1403) stays the fingerprint of the CURRENT sealed credential; the NOT VALID
-- CHECK below couples it to secret_cipher for every row written from now on (the service backfills a pre-1403 row on its next
-- write). The backfill INSERT copies the current fingerprints already on config rows. Declared `contract`: a new unique index and
-- CHECKs (arch:migration-compat), so deploy.sh halts for an operator rather than auto-rolling back over it.
CREATE TABLE IF NOT EXISTS "tenant_clearinghouse_credential_reservation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "vendor" text NOT NULL,
  "credential_fingerprint" text NOT NULL,
  "reserved_at" timestamptz NOT NULL DEFAULT now(),
  "released_at" timestamptz,
  "released_by_user_id" uuid,
  "release_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_clearinghouse_credential_reservation_vendor_ck" CHECK ("vendor" IN ('stedi', 'claimmd')),
  CONSTRAINT "tenant_clearinghouse_credential_reservation_fingerprint_ck" CHECK ("credential_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tenant_clearinghouse_credential_reservation_release_ck" CHECK (
    ("released_at" IS NULL AND "released_by_user_id" IS NULL AND "release_reason" IS NULL)
    OR ("released_at" IS NOT NULL AND "released_by_user_id" IS NOT NULL
        AND char_length(btrim("release_reason")) BETWEEN 8 AND 500))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_clearinghouse_credential_reservation_held_uq"
  ON "tenant_clearinghouse_credential_reservation" ("credential_fingerprint") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_clearinghouse_credential_reservation_org_idx"
  ON "tenant_clearinghouse_credential_reservation" ("organization_id", "released_at");--> statement-breakpoint

ALTER TABLE "tenant_clearinghouse_credential_reservation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_credential_reservation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_clearinghouse_credential_reservation_org" ON "tenant_clearinghouse_credential_reservation";--> statement-breakpoint
CREATE POLICY "tenant_clearinghouse_credential_reservation_org" ON "tenant_clearinghouse_credential_reservation" FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_clearinghouse_credential_reservation" TO chartwarden_app;--> statement-breakpoint
-- UPDATE is the release only: the organization, vendor and fingerprint of a reservation can never be rewritten. No DELETE.
GRANT UPDATE ("released_at", "released_by_user_id", "release_reason", "updated_at")
  ON "tenant_clearinghouse_credential_reservation" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "tenant_clearinghouse_credential_reservation" TO chartwarden_admin;--> statement-breakpoint
-- The boot check (no tenant holds the platform's own vendor key) reads across organizations on the platform carrier. It exists only
-- where provision-runtime-roles.ts has run; that script re-grants on every run (PLATFORM_READ_TABLES).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "tenant_clearinghouse_credential_reservation" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

-- A released reservation is final: it can never be re-held (a new save inserts a new row).
CREATE OR REPLACE FUNCTION tenant_clearinghouse_credential_reservation_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released clearinghouse credential reservation is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_clearinghouse_credential_reservation_final" ON tenant_clearinghouse_credential_reservation;--> statement-breakpoint
CREATE TRIGGER "trg_tenant_clearinghouse_credential_reservation_final" BEFORE UPDATE ON tenant_clearinghouse_credential_reservation
  FOR EACH ROW EXECUTE FUNCTION tenant_clearinghouse_credential_reservation_final();--> statement-breakpoint

-- M04 write-audit: every reservation and release is compliance-retained; the fingerprint is scrubbed like the config's (1403).
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_clearinghouse_credential_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['credential_fingerprint']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tenant_clearinghouse_credential_reservation.' || lower(TG_OP), 'tenant_clearinghouse_credential_reservation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_clearinghouse_credential_reservation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_tenant_clearinghouse_credential_reservation" ON tenant_clearinghouse_credential_reservation;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_clearinghouse_credential_reservation" AFTER INSERT OR UPDATE OR DELETE ON tenant_clearinghouse_credential_reservation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_clearinghouse_credential_reservation();--> statement-breakpoint

-- The current fingerprints already on config rows become held reservations (same organization, same vendor).
INSERT INTO "tenant_clearinghouse_credential_reservation" ("organization_id", "vendor", "credential_fingerprint", "reserved_at")
SELECT "organization_id", "vendor", "credential_fingerprint", "updated_at"
  FROM "tenant_clearinghouse_config"
 WHERE "credential_fingerprint" IS NOT NULL AND "vendor" IN ('stedi', 'claimmd')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- From now on a config row carries a fingerprint exactly when it carries a sealed credential. NOT VALID: a row sealed before 1403
-- keeps its NULL fingerprint until its next write, which the service backfills (it unseals the credential to compute it).
ALTER TABLE "tenant_clearinghouse_config" DROP CONSTRAINT IF EXISTS "tenant_clearinghouse_config_fingerprint_secret_ck";--> statement-breakpoint
ALTER TABLE "tenant_clearinghouse_config" ADD CONSTRAINT "tenant_clearinghouse_config_fingerprint_secret_ck"
  CHECK (("secret_cipher" IS NULL) = ("credential_fingerprint" IS NULL)) NOT VALID;--> statement-breakpoint

-- The release is its own platform duty (the 1388 shape): platform_ops only, where that role row already exists.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_clearinghouse.release_credential_platform', 'tenant_clearinghouse', 'release_credential_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'tenant_clearinghouse.release_credential_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
