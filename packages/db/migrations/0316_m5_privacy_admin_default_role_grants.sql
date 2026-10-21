-- M5 Privacy Officer screen — grant `privacy.admin` (M5 §4.7: "Privacy Officer, Compliance Officer · abac none ·
-- resync snapshot, etc.") to the roles the spec names, WHEREVER THE TENANT HAS CREATED THEM.
--
-- `privacy.admin` was catalogued in @chartwarden/auth (M5_CONTRIBUTED_PERMISSIONS) and no role granted it, so the M5 §5.1
-- "Privacy flags (`/patients/:id/privacy`)" screen and the §4.2 resync route were 403 for everyone. The code-side
-- source of truth is packages/auth/src/roles/templates.ts: `privacy.admin` is in the `hipaa_privacy_officer` floor and
-- in the `compliance_officer` default grant. `org_admin` is deliberately NOT granted (M5 §6 "Resync privacy flags":
-- org_admin ❌).
--
-- Nothing materializes ROLE_TEMPLATES, so a tenant without these roles is unchanged (the 0274 precedent). Idempotent
-- (`ON CONFLICT DO NOTHING`); never removes a grant. The permission mirror row is inserted too, in case the
-- environment's `permission` table predates `db:sync:permissions` picking the key up.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('privacy.admin', 'privacy', 'admin', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'privacy.admin'
  FROM "role" r
 WHERE r."key" IN ('hipaa_privacy_officer', 'compliance_officer')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
