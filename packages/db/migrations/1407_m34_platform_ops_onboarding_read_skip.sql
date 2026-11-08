-- compat: expand
-- M34 onboarding wizard: the platform-owned `platform_ops` role gets the wizard's read (onboarding.read_platform, the GET
-- /api/v1/platform/tenants/:orgSlug/onboarding) and its skip (onboarding.skip, the platform skip route). Both keys are in the catalog
-- since 0600 and both routes gate on the tenant_lifecycle_platform_ops predicate (the exact platform_ops role), but no migration or
-- role template granted them, so an operator holding only the template's keys was refused the wizard and never offered Skip. The
-- server's skippable list (CW-AC-15) still decides which steps a skip may settle. Idempotent. (1406 is left to the clearinghouse branch.)
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('onboarding.read_platform'), ('onboarding.skip')) AS k("key")
 WHERE r."key" = 'platform_ops'
   AND r."organization_id" IS NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
