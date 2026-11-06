-- compat: expand
-- M34 - the two platform clearinghouse permission keys (tenant_clearinghouse.read_platform / .write_platform), mirrored into
-- the DB catalog (the 1330 shape) and bound to the platform-owned `platform_ops` role row where it already exists (the
-- template grant in packages/auth/src/roles/templates.ts). Only platform_ops: the routes' `tenant_lifecycle_platform_ops`
-- predicate admits the exact platform_ops role, so a binding on platform_admin / platform_owner would be a grant the predicate
-- always denies. A role row created later gets them from `db:platform-role grant`.
-- No table, no column, no policy: the routes write through the tenant's own `tenant_clearinghouse_config` (1350) under the
-- target org's RLS. The tenant's own routes reuse billing.mac_credential.read / .admin. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_clearinghouse.read_platform', 'tenant_clearinghouse', 'read_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('tenant_clearinghouse.write_platform', 'tenant_clearinghouse', 'write_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('tenant_clearinghouse.read_platform'), ('tenant_clearinghouse.write_platform')) AS k("key")
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
