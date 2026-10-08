-- M2/M3 — auditor magic-link redemption (the batch-11 GAP-011 deferral).
--
-- Redeeming an auditor link attaches ONE least-privilege role, `external_auditor`, to the auditor's membership
-- (apps/backend/src/modules/03-authorization/auditor-access-grant.ts). That role holds exactly one permission,
-- `portal.engagement.read_auditor` (M31's engagement-scoped, read-only auditor view), and `role_permission
-- .permission_key` REFERENCES `permission.key`, so the key must exist as a `permission` row before the first
-- redemption can grant it. It is catalogued in @wardenx/auth (M31_CONTRIBUTED_PERMISSIONS) and normally lands
-- through `db:sync:permissions`; inserting it here (the 0316 `privacy.admin` precedent) means an environment
-- whose permission mirror predates that sync cannot fail the first redemption on a foreign key.
--
-- Nothing is granted to anyone here, no role is created and nothing is removed. Idempotent
-- (`ON CONFLICT DO NOTHING`).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('portal.engagement.read_auditor', 'portal_engagement', 'read_auditor', 'compliance', 'inOrg', '')
ON CONFLICT ("key") DO NOTHING;
