-- M3 — make the M2 direct-provisioning and tenant password-reset controls available to
-- existing organization administrators.
--
-- Fresh tenants already receive every non-platform permission on `org_admin` and
-- `administrator` through planRoleTemplateMaterialization(). Existing role rows are
-- intentionally not rewritten by that create-only materializer, so permissions added
-- after a tenant was created need an explicit additive backfill.
--
-- This migration is idempotent and never removes tenant-customized grants. The reset
-- route still refuses shared global identities and both operations remain step-up gated.

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('user.create', 'user', 'create', 'admin', 'none', 'Provision a user in the active organization'),
  ('user.password.reset', 'user', 'password.reset', 'admin', 'none', 'Reset an eligible user password')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", permission_key
  FROM "role" r
  CROSS JOIN (VALUES
    ('user.create'),
    ('user.password.reset')
  ) AS grants(permission_key)
 WHERE r."organization_id" IS NOT NULL
   AND r."key" IN ('org_admin', 'administrator')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
