-- compat: expand
-- M34 onboarding wizard v2 (slice 1a) - the five new permission keys, mirrored into the DB catalog (the 1253 / 1306 / 1307
-- shape), and their default grants. Idempotent.
--   platform keys (ABAC tenant_lifecycle_platform_ops, so only the `platform_ops` role passes the predicate):
--     onboarding.manage_platform           platform attest, re-open, org profile and compliance-officer assignment
--     go_live.approve_platform             the second party of the two-party go-live: approve and revoke
--     platform_tenant_baa.write_platform   BAA register create / update (was gated on the READ key alone)
--   tenant keys:
--     onboarding.manage_own                the org_admin's org profile + compliance-officer assignment (ABAC tenant_org_admin_role)
--     go_live.attest                       the compliance officer attests go-live readiness (ABAC tenant_compliance_officer_role)
-- Grants: the platform-owned `platform_ops` role (organization_id IS NULL) gets the three platform keys; every existing
-- tenant `compliance_officer` role gets go_live.attest and onboarding.read_own (so the officer can see the wizard they
-- attest; new tenants get both from the role templates); every existing tenant `org_admin` / `administrator` role gets
-- onboarding.manage_own (org profile and compliance-officer assignment). New tenants' org_admin holds the full non-platform
-- catalog by construction (role materialization), but a role that was materialized BEFORE this key existed holds a fixed
-- copy of the catalog and would answer 403 to its own org_admin on a tenant that is mid-onboarding.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('onboarding.manage_platform', 'onboarding_task', 'manage_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('onboarding.manage_own', 'onboarding_task', 'manage_own', 'admin', 'tenant_org_admin_role', ''),
  ('go_live.attest', 'tenant_go_live_attestation', 'attest', 'compliance', 'tenant_compliance_officer_role', ''),
  ('go_live.approve_platform', 'tenant_go_live_attestation', 'approve_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('platform_tenant_baa.write_platform', 'platform_tenant_baa_record', 'write_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('onboarding.manage_platform'), ('go_live.approve_platform'), ('platform_tenant_baa.write_platform')) AS k("key")
 WHERE r."key" = 'platform_ops'
   AND r."organization_id" IS NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('go_live.attest'), ('onboarding.read_own')) AS k("key")
 WHERE r."key" = 'compliance_officer'
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'onboarding.manage_own'
  FROM "role" r
 WHERE r."key" IN ('org_admin', 'administrator')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
