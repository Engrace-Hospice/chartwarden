// @wardenx/auth · roles (M3 — Authorization). Owned per module-manifest.ts codePath
// `packages/auth/src/roles`. The role catalog + `system_locked` permission floor (M3-T02)
// ship in ./templates; the org-seed routine (clone templates into an org) lands in M3-T06.
// ./org-wide-scope derives, from those floors, the one answer to "which roles read the whole org's
// patients without a caseload assignment" (F-096 — it used to be four literals that disagreed).
export {
  type RoleCategory,
  type RoleTemplate,
  type RolePermissionSeedRow,
  type ScopeLevel,
  type SystemLockedRoleKey,
  type PlatformOpsRoleKey,
  ROLE_TEMPLATES,
  SYSTEM_LOCKED_FLOORS,
  PLATFORM_OPS_ROLE_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  M35_BILLING_ADMIN_READ_KEYS,
  M35_BILLING_ADMIN_WRITE_KEYS,
  M35_REFUND_APPROVE_KEY,
  floorFor,
  floorViolations,
  isSystemLocked,
  satisfiesFloor,
  rolesForPermission,
  platformOpsRolePermissionSeedRows,
} from "./templates";
export { ORG_WIDE_SCOPE_ROLES, hasOrgWideScope } from "./org-wide-scope";
