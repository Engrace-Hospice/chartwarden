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
export { createDbRoleStore } from "./role-store";
export { createDbMembershipRoleStore } from "./membership-role-store";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import {
  type AuthzRouteDeps,
  createFixedPermissionResolver as _fixedPerms,
  createInMemoryAuditorSessionMinter as _auditorMinter,
  createInMemoryBreakGlassStore as _breakGlass,
  createInMemoryComplianceNotifier as _notifier,
  createInMemoryEngagementStore as _engagements,
} from "./authz-ports";
import { createDbMembershipRoleStore as _dbMembershipRoles } from "./membership-role-store";
import { createDbRoleStore as _dbRoleStore } from "./role-store";
import { registerAuthorizationRoutes as _registerAuthzRoutes } from "./routes/authz-routes";
import { createInMemoryAuditExecutor } from "../02-identity/index";

/**
 * Mount the M3 authorization REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present). The role catalog runs on the REAL Drizzle
 * RoleStore + MembershipRoleStore (real Drizzle); the remaining route deps (break-glass, engagements,
 * auditor sessions, compliance notifier, anti-escalation resolver, audit sink) are still in-memory and
 * are replaced by their Drizzle stores in follow-up PRs — progressive wiring of the backend surface.
 * requirePermission is the live RBAC resolver (registerDbEffectivePermissionResolver).
 */
export function mountAuthorizationRoutes(app: FastifyInstance, db: DbClient): void {
  const deps: AuthzRouteDeps = {
    roles: _dbRoleStore(db),
    membershipRoles: _dbMembershipRoles(db),
    breakGlass: _breakGlass().store,
    engagements: _engagements().store,
    auditorSessions: _auditorMinter().minter,
    notifier: _notifier().notifier,
    effectivePermissions: _fixedPerms([]).resolver,
    audit: createInMemoryAuditExecutor().executor,
  };
  _registerAuthzRoutes(app, deps);
}
