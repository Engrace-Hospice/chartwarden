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
export {
  M3_IN_ORG_PREDICATE,
  M3_STEP_UP_PREDICATE,
  registerAuthorizationAbacPredicates,
} from "./abac-predicates";
export { registerAuthorizationRoutes } from "./routes/authz-routes";
export { createDbRoleStore } from "./role-store";
export { createDbMembershipRoleStore } from "./membership-role-store";
export { createDbBreakGlassStore } from "./break-glass-store";

import { organizationSettingsReader, schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  type AuthzRouteDeps,
  createInMemoryAuditorSessionMinter as _auditorMinter,
  createInMemoryEngagementStore as _engagements,
  createFixedPermissionResolver as _fixedPerms,
  createInMemoryComplianceNotifier as _notifier,
} from "./authz-ports";
import { createDbBreakGlassStore as _dbBreakGlass } from "./break-glass-store";
import { registerBreakGlassContract as _registerBreakGlass } from "./contract";
import { createDbMembershipRoleStore as _dbMembershipRoles } from "./membership-role-store";
import { createDbRoleStore as _dbRoleStore } from "./role-store";
import { registerAuthorizationRoutes as _registerAuthzRoutes } from "./routes/authz-routes";

/**
 * Mount the M3 authorization REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present). The role catalog + break-glass run on the
 * REAL Drizzle stores; mounting also registers the §2.2 break-glass BRANCH (`registerBreakGlassContract`)
 * over that durable store + db, so an ABAC-denied access under open glass is allowed AND audited at
 * `critical` (audit #M3 — previously test-only/in-memory). The route audit sink is the DURABLE
 * Drizzle path (`audit: db` — `AuditExecutor` is structurally `insert(table).values(row)`, the M2
 * precedent; migration 0119 gave `wardenx_app` the INSERT policy that makes it legal under RLS), so
 * every M3 lifecycle event (role grant/revoke, break-glass, engagement) lands in `audit_event`
 * instead of a per-process Map. The remaining route deps (engagements, auditor sessions, compliance
 * notifier, anti-escalation resolver) are still in-memory — recorded in the TASK-001 in-memory
 * ledger at the composition root — and land in follow-up M3 wiring (TASK-004).
 * requirePermission is the live RBAC resolver.
 */
export function mountAuthorizationRoutes(app: FastifyInstance, db: DbClient): void {
  const breakGlass = _dbBreakGlass(db);
  // §2.2 / §7.4 — wire the break-glass branch over the durable store; the per-access critical row is
  // written under withOrgContext (db) so RLS scopes it. Idempotent (sets the contract's seams).
  _registerBreakGlass({ store: breakGlass, db });
  const deps: AuthzRouteDeps = {
    roles: _dbRoleStore(db),
    membershipRoles: _dbMembershipRoles(db),
    breakGlass,
    engagements: _engagements().store,
    auditorSessions: _auditorMinter().minter,
    notifier: _notifier().notifier,
    effectivePermissions: _fixedPerms([]).resolver,
    audit: db,
    // audit C2 — tenant policy for the break-glass co-sign requirement, read server-side from the
    // M1 organization-settings registry (`breakglass_cosign_required`, M3's key). Fail CLOSED to the
    // registered default (false) if the row is absent or unreadable: `cosign_pending` grants no
    // access, so a read failure must not silently withhold emergency chart access.
    cosignPolicy: async (organizationId) => {
      try {
        const rows = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
          tx
            .select({ settings: schema.organizations.settings })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, organizationId))
            .limit(1),
        );
        const settings = rows[0]?.settings as Record<string, unknown> | undefined;
        return (
          organizationSettingsReader.get<boolean>(settings, "breakglass_cosign_required") === true
        );
      } catch {
        return false;
      }
    },
  };
  _registerAuthzRoutes(app, deps);
}
