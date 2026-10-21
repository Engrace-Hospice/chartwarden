-- GAP-032 - M40 `emergency_service_jurisdiction`: the TENANT-CURATED PSAP catalog behind the SOS terminus's
-- `surface_psap_number` effect (M20 spec 2.2.2 (b), INT-031). There is no national PSAP dataset in this
-- platform and none is invented: a tenant enters (and re-verifies) the administrative line of the PSAP that
-- covers each of its places, by drawn polygon, per-location default or one org default. Each row carries
-- `verified_at` / `verify_every_days` so a stale number is labelled, never silently trusted. `source` reserves
-- `platform_seed` for a future licensed-dataset loader. The number is a PUBLIC administrative line, not PHI.
--
-- Precedent: `external_grief_resource` (0463, GAP-158): org-scoped reference data, retire-never-delete.
-- The platform NEVER dials a PSAP; this table only feeds the "surface to a human" line in the authenticated UI.
CREATE TABLE IF NOT EXISTS "emergency_service_jurisdiction" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "state" char(2) NOT NULL,
  "county_fips" char(5),
  "polygon" jsonb,
  "psap_name" text NOT NULL,
  "psap_phone" text NOT NULL,
  "secondary_phone" text,
  "applies_to_location_id" uuid,
  "is_org_default" boolean DEFAULT false NOT NULL,
  "source" text DEFAULT 'tenant_entered' NOT NULL,
  "source_ref" text,
  "verified_at" timestamptz NOT NULL,
  "verified_by_membership_id" uuid,
  "verify_every_days" integer DEFAULT 180 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "m40_esj_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "m40_esj_location_id_fk" FOREIGN KEY ("applies_to_location_id") REFERENCES "location"("id") ON DELETE restrict,
  CONSTRAINT "m40_esj_source" CHECK ("source" IN ('tenant_entered','platform_seed')),
  CONSTRAINT "m40_esj_state" CHECK ("state" ~ '^[A-Z]{2}$'),
  CONSTRAINT "m40_esj_phone" CHECK ("psap_phone" ~ '^\+[1-9][0-9]{6,14}$' AND ("secondary_phone" IS NULL OR "secondary_phone" ~ '^\+[1-9][0-9]{6,14}$')),
  CONSTRAINT "m40_esj_verify_days" CHECK ("verify_every_days" BETWEEN 30 AND 730),
  CONSTRAINT "m40_esj_polygon_shape" CHECK ("polygon" IS NULL OR jsonb_typeof("polygon") = 'array'),
  -- A row must match SOMETHING (a drawn area, a location, or be the org default), and the org default is a
  -- plain row: no polygon and no location.
  CONSTRAINT "m40_esj_matches_something" CHECK ("polygon" IS NOT NULL OR "applies_to_location_id" IS NOT NULL OR "is_org_default"),
  CONSTRAINT "m40_esj_org_default_plain" CHECK (NOT "is_org_default" OR ("polygon" IS NULL AND "applies_to_location_id" IS NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "esj_org_idx" ON "emergency_service_jurisdiction" ("organization_id", "is_active", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "esj_location_idx" ON "emergency_service_jurisdiction" ("applies_to_location_id") WHERE "applies_to_location_id" IS NOT NULL;--> statement-breakpoint
-- At most one ACTIVE org default per org, and one ACTIVE per-location default (no polygon) per location.
CREATE UNIQUE INDEX IF NOT EXISTS "esj_org_default_uq" ON "emergency_service_jurisdiction" ("organization_id") WHERE "is_org_default" AND "is_active";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "esj_location_default_uq" ON "emergency_service_jurisdiction" ("organization_id", "applies_to_location_id") WHERE "applies_to_location_id" IS NOT NULL AND "polygon" IS NULL AND "is_active";--> statement-breakpoint
ALTER TABLE "emergency_service_jurisdiction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "emergency_service_jurisdiction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "emergency_service_jurisdiction_org" ON "emergency_service_jurisdiction";--> statement-breakpoint
CREATE POLICY "emergency_service_jurisdiction_org" ON "emergency_service_jurisdiction"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "emergency_service_jurisdiction" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "emergency_service_jurisdiction" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "emergency_service_jurisdiction_audit"
  AFTER INSERT OR UPDATE OR DELETE ON emergency_service_jurisdiction
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- Permission mirror rows (role_permission.permission_key FKs to permission; the keys are catalogued in
-- @wardenx/auth M40_CONTRIBUTED_PERMISSIONS and mirrored here so a fresh environment can grant them).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('mdm.psap_jurisdiction.manage', 'psap_jurisdiction', 'manage', 'admin', 'none', ''),
  ('mdm.psap_jurisdiction.read', 'psap_jurisdiction', 'read', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;
