// apps/backend/src/modules/03-authorization — Module 3 (Authorization) backend surface.
// Owned per module-manifest.ts codePath `apps/backend/src/modules/03-authorization`.
//
// M3-T08 lands the Module 3 route inventory (M3 spec §4.3–4.4): the role catalog +
// assignment surface, the break-glass console (§7.4), and the auditor-engagement console
// (§7.5), each behind a §6 meta-permission through the REAL Authorization Contract
// (`requirePermission`/`requireSession`, M3-T05) — this is where the contract goes live for
// M3's own routes. It also registers the §2.2 break-glass BRANCH (the checker + critical
// per-access audit hook) over the contract's fail-closed seams (`contract.ts`).
export {
  AUTHZ_AUDIT_EVENTS,
  auditAuditorEnrolled,
  auditAuthzDenied,
  auditBreakGlassAccess,
  auditBreakGlassCosigned,
  auditBreakGlassInvoked,
  auditBreakGlassRevoked,
  auditEngagementCreated,
  auditEngagementUpdated,
  auditEscalationBlocked,
  auditRoleAssigned,
  auditRoleCreated,
  auditRoleDeleted,
  auditRoleRevoked,
  auditRoleUpdated,
} from "./audit/authz-audit";
export {
  type ActorPermissionResolver,
  type AuditorSessionMinterPort,
  type AuthzRouteDeps,
  type BreakGlassGrantRef,
  type BreakGlassStatus,
  type BreakGlassStore,
  type BreakGlassView,
  type ComplianceNotifier,
  type EngagementStatus,
  type EngagementStore,
  type EngagementSummary,
  type EngagementView,
  type MembershipRoleStore,
  type MembershipRoleView,
  RoleLockedError,
  type RoleStore,
  type RoleView,
  type ScopeLevelInput,
  createFixedPermissionResolver,
  createInMemoryAuditorSessionMinter,
  createInMemoryBreakGlassStore,
  createInMemoryComplianceNotifier,
  createInMemoryEngagementStore,
  createInMemoryMembershipRoleStore,
  createInMemoryRoleStore,
} from "./authz-ports";
export {
  type BreakGlassContractDeps,
  registerBreakGlassContract,
} from "./contract";
export { registerAuthorizationRoutes } from "./routes/authz-routes";
