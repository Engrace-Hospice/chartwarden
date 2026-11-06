-- compat: expand
-- M12 / M34 - the DoseSpot clinic registration permission keys (tenant onboarding slice 4, ADR-0110), mirrored into the DB
-- catalog (the 1330 / 1352 / 1354 shape):
--   prescribing.clinic.read / .admin   the tenant's OWN surface (GET|PUT /api/v1/tenant/dosespot ...). ORG-LEVEL on purpose: the
--                                      registration decides where EVERY prescription of the organization goes, so it is bound
--                                      to the org-wide admin roles ONLY (org_admin and administrator, by role key, as 1354 does
--                                      for billing.clearinghouse.*): the prescriber-roster key (prescribing.admin.roster) does not
--                                      open it, and no other role gets it here or from the role-template planner (the two
--                                      full-catalog roles take every non-platform key; every other template lists its grants).
--   tenant_dosespot.read_platform / .write_platform   a platform operator entering the registration for a tenant that is still
--                                      onboarding, bound to the platform-owned `platform_ops` role row where it already exists
--                                      (the template grant in packages/auth/src/roles/templates.ts). Only platform_ops: the
--                                      routes' `tenant_lifecycle_platform_ops` predicate admits the exact platform_ops role, so a
--                                      binding on platform_admin / platform_owner would be a grant the predicate always denies. A
--                                      role row created later gets them from `db:platform-role grant`.
-- No table, no column, no policy: both lanes write through the tenant's own `dosespot_clinic_registration` (1380) under the
-- target org's RLS. Existing tenants get the tenant grant here; new tenants from the role templates. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('prescribing.clinic.read', 'dosespot_clinic', 'read', 'compliance', 'none', ''),
  ('prescribing.clinic.admin', 'dosespot_clinic', 'admin', 'compliance', 'none', ''),
  ('tenant_dosespot.read_platform', 'tenant_dosespot', 'read_platform', 'platform', 'tenant_lifecycle_platform_ops', ''),
  ('tenant_dosespot.write_platform', 'tenant_dosespot', 'write_platform', 'platform', 'tenant_lifecycle_platform_ops', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('prescribing.clinic.read'), ('prescribing.clinic.admin')) AS k("key")
 WHERE r."key" IN ('org_admin', 'administrator')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('tenant_dosespot.read_platform'), ('tenant_dosespot.write_platform')) AS k("key")
 WHERE r."organization_id" IS NULL
   AND r."key" = 'platform_ops'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
