-- compat: contract
-- M34 - revoke the dead `onboarding.manage_own` grant from tenant `administrator` roles (migration 1329 granted it to both
-- `org_admin` and `administrator`).
--   * The routes behind the key (PATCH /tenant/org-profile, PUT /tenant/compliance-officer) are gated on requirePermission AND
--     requireAbac(_, 'tenant_org_admin_role'); that predicate (abac-predicates.ts) and the wizard's actorMayActOnStep admit the
--     LITERAL role key `org_admin` only. `administrator` is a different key (org_admin supersedes it, but the role-keyed
--     predicates do not read it that way), so an administrator-only member passed the permission check and then got a 403 at
--     the predicate: a grant that confers nothing and reads as if it did.
--   * Authorization is NOT widened: the predicate is unchanged, `org_admin` keeps the key, and nothing gains access. Only the
--     misleading grant goes. New tenants no longer receive it either: planRoleTemplateMaterialization withholds it from
--     `administrator` (ADMINISTRATOR_EXCLUDED_KEYS in packages/auth roles/template-materialization.ts), and a test pins that the
--     roles holding the key are exactly the ones the predicate admits.
--   * It is `contract` because it removes access an old release could still reach for (the permission check; the predicate
--     denied it regardless). The DELETE is audited by role_permission's trigger, org by org. Idempotent: a second run matches
--     nothing. Only tenant-owned rows (organization_id IS NOT NULL) are touched; 1329 never granted it to a platform template.
DELETE FROM "role_permission" rp
 USING "role" r
 WHERE rp."role_id" = r."id"
   AND rp."permission_key" = 'onboarding.manage_own'
   AND r."key" = 'administrator'
   AND r."organization_id" IS NOT NULL;
