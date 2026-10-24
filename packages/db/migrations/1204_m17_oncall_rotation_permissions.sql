-- GAP-029 - the M17 on-call rotation routes demand `oncall_rotation.read` / `oncall_rotation.manage`, but no migration
-- mirrored the two catalog rows into `permission` (0600 predates them), so role_permission (FK to permission) could not
-- hold a grant and `materializeRoleTemplatesForOrg` could not give them to a new tenant's full-catalog admin roles.
-- Same shape as 1092: a catalog row (category scheduling, no ABAC, as contributed.ts declares) and a grant to the two
-- full-catalog admin roles only, so existing tenants match what a freshly materialized tenant gets. No other role changes.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('oncall_rotation.manage', 'oncall_rotation', 'manage', 'scheduling', 'none', ''),
  ('oncall_rotation.read', 'oncall_rotation', 'read', 'scheduling', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('oncall_rotation.read'), ('oncall_rotation.manage')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
