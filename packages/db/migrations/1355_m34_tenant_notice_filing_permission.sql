-- compat: expand
-- M34 - tenant_notice_filing.withdraw_platform: a platform operator withdraws a tenant's mistaken "filed outside ChartWarden"
-- NOE / NOTR record (owner decision 2026-11-06). Mirrored into the DB catalog (the 1352 shape) and bound to the platform-owned
-- `platform_ops` role row where it already exists (the template grant in packages/auth/src/roles/templates.ts). Only platform_ops:
-- the routes' `tenant_lifecycle_platform_ops` predicate admits the exact platform_ops role. A role row created later gets it from
-- `db:platform-role grant`. No table, no column, no policy. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_notice_filing.withdraw_platform', 'tenant_notice_filing', 'withdraw_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'tenant_notice_filing.withdraw_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
