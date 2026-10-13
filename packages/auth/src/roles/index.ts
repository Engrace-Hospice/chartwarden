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
export {
  SYSTEM_ROLE_DISPLAY_NAMES,
  type SystemRoleDisplayNameKey,
  systemRoleDisplayName,
} from "./display-names";
export { LAB_RECOVERY_DEFAULT_GRANTS, LAB_RECOVERY_KEYS } from "./lab-recovery-grants";
export { INTAKE_DEFAULT_GRANTS, INTAKE_ROLE_KEYS } from "./intake-grants";
export {
  SSN_DEFAULT_GRANTS,
  SSN_READ_KEY,
  SSN_READ_ROLE_KEYS,
  SSN_WRITE_KEY,
  SSN_WRITE_ROLE_KEYS,
  type SsnGrantRoleKey,
} from "./ssn-grants";
export {
  ADMITTING_CLINICIAN_DEFAULT_GRANTS,
  ADMITTING_CLINICIAN_ROLE_KEYS,
  type AdmittingClinicianRoleKey,
  hasAdmittingClinicianRole,
} from "./admitting-clinician-grants";
export {
  PLATFORM_GRANTABLE_ROLE_KEYS,
  type PlatformGrantableRoleKey,
  RESERVED_PLATFORM_ROLE_CATEGORY,
  RESERVED_PLATFORM_ROLE_KEYS,
  RESERVED_PLATFORM_ROLE_PREFIX,
  isPlatformGrantableRoleKey,
  isReservedPlatformRoleKey,
  isTenantRoleReserved,
  roleConfersKey,
} from "./platform-reserved";
export {
  FULL_CATALOG_ROLE_KEYS,
  type MirrorPermission,
  PLATFORM_PERMISSION_CATEGORY,
  type PlannedRole,
  planRoleTemplateMaterialization,
} from "./template-materialization";
export {
  type GrantInput,
  type GrantScopeParse,
  type GrantViolation,
  type MembershipReach,
  NO_REACH_ID,
  type ReachWithDiagnostics,
  type RoleGrantScope,
  TIME_BOUND_ROLE_CATEGORY,
  effectiveReach,
  effectiveReachWithDiagnostics,
  parseRoleGrantScope,
  validateRoleGrant,
} from "./grant-scope";
