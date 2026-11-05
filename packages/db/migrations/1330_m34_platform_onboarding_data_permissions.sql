-- compat: expand
-- M34 - the two platform onboarding-data permission keys (read_platform / write_platform), mirrored into the DB catalog (the 1253 /
-- 1306 / 1307 shape) and bound to the platform-owned role rows that already exist (platform_ops / platform_admin / platform_owner,
-- the template grants in packages/auth/src/roles/templates.ts). A role row created later gets them from `db:platform-role grant`.
-- No table, no column, no policy: the routes write through the tenant's own tables under the target org's RLS. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_onboarding_data.read_platform', 'tenant_onboarding_data', 'read_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('tenant_onboarding_data.write_platform', 'tenant_onboarding_data', 'write_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('tenant_onboarding_data.read_platform'), ('tenant_onboarding_data.write_platform')) AS k("key")
 WHERE r."organization_id" IS NULL
   AND r."key" IN ('platform_ops', 'platform_admin', 'platform_owner')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
