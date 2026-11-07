-- compat: expand
-- M34 - tenant_baa_document.upload_platform: a platform operator uploads the signed BAA for a tenant that is still onboarding (owner
-- decision 2026-11-06). The NARROWEST grant that does it: the key admits one route, which files one document kind (`tenant_baa`) for
-- the tenant in the path, on the tenant's own RLS scope (`app.org_id` = that tenant). It is NOT `documents.upload`: the key reads no
-- document, lists none, and uploads no other kind. Mirrored into the DB catalog (the 1352 / 1355 shape) and bound to the
-- platform-owned `platform_ops` role row where it already exists (the template grant in packages/auth/src/roles/templates.ts). Only
-- platform_ops: the route's `tenant_lifecycle_platform_ops` predicate admits the exact platform_ops role. A role row created later gets
-- it from `db:platform-role grant`. No table, no column, no policy. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('tenant_baa_document.upload_platform', 'tenant_baa_document', 'upload_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'tenant_baa_document.upload_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
