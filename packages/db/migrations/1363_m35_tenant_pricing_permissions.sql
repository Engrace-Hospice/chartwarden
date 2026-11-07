-- compat: expand
-- Slice 2 (tenant pricing) - the two platform permission keys, mirrored into the DB catalog (the 1253 / 1329 / 1330 shape), and their
-- default grants. Idempotent.
--   subscription.onboard_platform         create a tenant's subscription during onboarding step 2 (plan & contract) and change its billing
--                                         service mode. ABAC `tenant_lifecycle_platform_ops` admits the EXACT `platform_ops` role, so
--                                         only that role carries the key (a grant to a role the predicate always denies would be a
--                                         control that exists on paper only).
--   subscription.pricing_read_platform    the read-only pricing surface an operator prices a tenant with: the published plans, the
--                                         price preview, and a tenant's contract and statements. ABAC `platform_billing_scope` (any
--                                         platform-ops role), granted to `platform_ops` and the three billing roles.
-- No table, column or policy: the tenant read of its own plan and statement reuses `subscription.read`.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('subscription.onboard_platform', 'subscription', 'onboard_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('subscription.pricing_read_platform', 'subscription', 'pricing_read_platform', 'platform', 'platform_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'subscription.onboard_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'subscription.pricing_read_platform'
  FROM "role" r
 WHERE r."organization_id" IS NULL
   AND r."key" IN ('platform_ops', 'platform_billing_admin', 'platform_admin', 'platform_owner')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
