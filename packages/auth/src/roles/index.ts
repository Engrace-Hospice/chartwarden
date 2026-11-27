// @chartwarden/auth · roles (M3 — Authorization). Owned per module-manifest.ts codePath
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
  type PlatformDutyRoleKey,
  type PlatformRoleTemplateKey,
  PLATFORM_DUTY_ROLE_KEYS,
  PLATFORM_PRICING_READ_DUTY_ROLE_KEYS,
  ROLE_TEMPLATES,
  SYSTEM_LOCKED_FLOORS,
  PLATFORM_OPS_ROLE_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS,
  M34_PLATFORM_OPS_ONBOARDING_KEYS,
  M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS,
  M35_PLATFORM_PRICING_OPERATOR_KEYS,
  M35_PRICING_READ_KEY,
  PLATFORM_BAA_STEWARD_KEYS,
  PLATFORM_GO_LIVE_APPROVER_KEYS,
  PLATFORM_ONBOARDING_DATA_KEYS,
  PLATFORM_ONBOARDING_READ_KEY,
  PLATFORM_ONBOARDING_ROLE_KEYS,
  PLATFORM_ROLE_CONFLICTS,
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
export {
  BUSINESS_ADMIN_SCOPE_ROLES,
  ORG_WIDE_SCOPE_ROLES,
  hasOrgWideScope,
} from "./org-wide-scope";
export {
  SYSTEM_ROLE_DISPLAY_NAMES,
  type SystemRoleDisplayNameKey,
  systemRoleDisplayName,
} from "./display-names";
export { LAB_RECOVERY_DEFAULT_GRANTS, LAB_RECOVERY_KEYS } from "./lab-recovery-grants";
export {
  EXTERNAL_AUDITOR_ROLE_KEY,
  SYSTEM_MANAGED_ROLE_KEYS,
  isSystemManagedRoleKey,
} from "./system-managed";
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
export { CODE_STATUS_EDITOR_ROLE_KEYS } from "./code-status-grants";
export {
  NOTE_CLOSURE_DEFAULT_GRANTS,
  NOTE_CLOSURE_PERMISSION_KEYS,
  NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS,
  NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS,
} from "./note-closure-grants";
export {
  DRAFT_POLICY_ADMIN_PERMISSION_KEY,
  DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS,
  VISIT_NOTE_DRAFT_DEFAULT_GRANTS,
} from "./visit-note-draft-grants";
export { CARE_PLAN_DEFAULT_GRANTS, CARE_PLAN_GRANTEE_ROLE_KEYS } from "./care-plan-grants";
export {
  DISCIPLINE_PLAN_DEFAULT_GRANTS,
  DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS,
} from "./discipline-plan-grants";
export {
  PLATFORM_ALERT_AUDIENCE_ROLE_KEY,
  PLATFORM_OPS_ROLE_KEY,
  PLATFORM_GRANTABLE_ROLE_KEYS,
  type PlatformGrantableRoleKey,
  RESERVED_PLATFORM_ROLE_CATEGORY,
  RESERVED_PLATFORM_ROLE_KEYS,
  RESERVED_PLATFORM_ROLE_PREFIX,
  SUPERADMIN_ROLE_KEY,
  expandSuperadminRoles,
  isPlatformGrantableRoleKey,
  isReservedPlatformRoleKey,
  isTenantRoleReserved,
  roleConfersKey,
} from "./platform-reserved";
export {
  ADMINISTRATOR_EXCLUDED_KEYS,
  FULL_CATALOG_EXCLUDED_KEYS,
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
