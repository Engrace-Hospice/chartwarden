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
  type AuditorAccessGrantor,
  EXTERNAL_AUDITOR_PERMISSIONS,
  EXTERNAL_AUDITOR_ROLE_KEY,
  createDbAuditorAccessGrantor,
} from "./auditor-access-grant";
export {
  AUTHZ_AUDIT_EVENTS,
  auditAuditorEnrolled,
  auditAuthzDenied,
  auditBreakGlassAccess,
  auditBreakGlassCosignRefused,
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
  type AuditorLinkDeliveryPort,
  type AuditorSessionMinterPort,
  type AuthzRouteDeps,
  BreakGlassCosignError,
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
export { registerAuthorizationSeams } from "./seams";
export { SUPERVISORY_ROLE_KEYS, createSupervisorReader } from "./supervisor-reader";
// F-097 — the M2 §D3 role attach on accept. Exported for the composition root, which binds it into
// M2's identity routes (M2 is `dependsOn: [1]` and cannot import this module itself).
export {
  type ProposedRoleAttachResult,
  type ProposedRoleAttacher,
  createDbProposedRoleAttacher,
} from "./proposed-role-attacher";
// GAP-008 — the inviter-ceiling guard bound into M2's invite-create route by the composition root.
export {
  type OrgRoleLookup,
  type ProposableRole,
  type ProposedRoleGuard,
  type RoleCeilingVerdict,
  ROLE_ASSIGN_PERMISSION,
  checkRoleCeiling,
  createDbOrgRoleLookup,
  createProposedRoleGuard,
} from "./proposed-role-ceiling";
export { createDbBreakGlassStore } from "./break-glass-store";
// GAP-117 — the reap_breakglass cron (expires lapsed grants).
export {
  M3_PLATFORM_JOB_ID,
  registerM3CronWorkers,
  scheduleM3Jobs,
  wireM3ReaperTenancy,
} from "./break-glass-reaper";
// GAP-011 / GAP-093 — the durable engagement store and the published AuditorEngagementReader.
export { createDbEngagementStore } from "./engagement-store";
export { createDbAuditorEngagementReader } from "./engagement-reader";
export { M3_OUTBOX_EVENTS } from "./events-by-m3";
export type { M3OutboxPublisher } from "./authz-ports";

import type { AuditExecutor, NewAuditEvent } from "@wardenx/audit";
import type { RbacEngineHandle } from "@wardenx/auth";
import { organizationSettingsReader, schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../bootstrap/index";
import {
  type AuditorLinkDeliveryPort,
  type AuthzRouteDeps,
  type ComplianceNotifier,
  type M3OutboxPublisher,
  createFixedPermissionResolver as _fixedPerms,
  createInMemoryComplianceNotifier as _notifier,
} from "./authz-ports";
import { createDbBreakGlassStore as _dbBreakGlass } from "./break-glass-store";
import { registerBreakGlassContract as _registerBreakGlass } from "./contract";
import { createDbEngagementStore as _dbEngagements } from "./engagement-store";
import { createDbMembershipRoleStore as _dbMembershipRoles } from "./membership-role-store";
import { createDbRoleStore as _dbRoleStore } from "./role-store";
import { registerAuthorizationRoutes as _registerAuthzRoutes } from "./routes/authz-routes";

/** Compliance is notified by the store's same-tx `m3.breakglass.invoked` outbox row; nothing left to do here. */
const DURABLE_VIA_OUTBOX_NOTIFIER: ComplianceNotifier = { notify: () => undefined };

/**
 * M3 lifecycle audits are emitted after the individual store transaction has completed.  A raw
 * pooled DB client has no `app.org_id`, so its `audit_event` INSERT is refused under production
 * RLS (while the development BYPASSRLS role hides the defect).  Keep the route-facing AuditExecutor
 * shape, but establish tenant context from the immutable audit row before writing it.
 */
export function createTenantAuditExecutor(db: DbClient): AuditExecutor {
  return {
    insert(table) {
      return {
        values(row: NewAuditEvent) {
          const organizationId = row.organizationId;
          if (typeof organizationId !== "string") {
            throw new Error("M3 tenant audit event is missing an organization id");
          }
          return withOrgContext(
            db,
            { organizationId, userId: typeof row.actorUserId === "string" ? row.actorUserId : "" },
            (tx) => tx.insert(table).values(row),
          );
        },
      };
    },
  };
}

/**
 * Mount the M3 authorization REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present). The role catalog + break-glass run on the
 * REAL Drizzle stores; mounting also registers the §2.2 break-glass BRANCH (`registerBreakGlassContract`)
 * over that durable store + db, so an ABAC-denied access under open glass is allowed AND audited at
 * `critical` (audit #M3 — previously test-only/in-memory). The route audit sink is the DURABLE
 * Drizzle path (`audit: db` — `AuditExecutor` is structurally `insert(table).values(row)`, the M2
 * precedent; migration 0119 gave `wardenx_app` the INSERT policy that makes it legal under RLS), so
 * every M3 lifecycle event (role grant/revoke, break-glass, engagement) lands in `audit_event`
 * instead of a per-process Map. Engagements are durable too (GAP-011: `createDbEngagementStore`). The
 * remaining route deps (auditor sessions, compliance notifier, anti-escalation resolver) are still in-memory — recorded in the TASK-001 in-memory
 * ledger at the composition root — and land in follow-up M3 wiring (TASK-004).
 * requirePermission is the live RBAC resolver.
 */
export function mountAuthorizationRoutes(
  app: FastifyInstance,
  db: DbClient,
  /**
   * TASK-004 — the boot-registered RBAC engine handle (the SAME resolver + §2.5 cache
   * `requirePermission` runs on; a second instance here would split the invalidation cache).
   * The composition root passes it; absent (slice/tests), the fixed-empty resolver stands and the
   * in-memory ledger records the gap.
   */
  rbac?: RbacEngineHandle,
  /**
   * GAP-010 — the `m3.*` catalog-validating outbox publisher (`bindCallerModule(txOutboxPublisher, "m3")`).
   * With it, break-glass invoke/revoke and role assign/revoke publish their events on the state change's own
   * tx, and the Compliance notification is the DURABLE `m3.breakglass.invoked` row (M36 delivers it). Absent
   * (slice/tests) the in-memory notifier stands and the composition root records the gap.
   */
  outbox?: M3OutboxPublisher,
  /** Delivery of the minted auditor link (email). The composition root binds it; absent in slice/tests. */
  auditorLinkDelivery?: AuditorLinkDeliveryPort,
): void {
  const breakGlass = _dbBreakGlass(db, outbox);
  // §2.2 / §7.4 — wire the break-glass branch over the durable store; the per-access critical row is
  // written under withOrgContext (db) so RLS scopes it. Idempotent (sets the contract's seams).
  _registerBreakGlass({ store: breakGlass, db });
  const deps: AuthzRouteDeps = {
    roles: _dbRoleStore(db),
    membershipRoles: _dbMembershipRoles(db, outbox),
    breakGlass,
    // GAP-011 — durable: `auditor_engagement` is written (RLS-scoped), so the M31 auditor view has a real engagement to resolve.
    engagements: _dbEngagements(db),
    // GAP-011 — M2's boot-validated `AuditorSessionMinter` seam (durable `auditor_magic_link` issuer on a db
    // boot), resolved at call time so the seam registered by `registerIdentitySeams` is the one used.
    auditorSessions: {
      mintAuditorSession: (input) => getSeam("AuditorSessionMinter").mintAuditorSession(input),
    },
    ...(auditorLinkDelivery ? { auditorLinkDelivery } : {}),
    // With an outbox the break-glass store has already published `m3.breakglass.invoked` in the invoke's tx, so
    // the route-level notify must not notify a second time (the in-memory array nothing read was GAP-010).
    notifier: outbox ? DURABLE_VIA_OUTBOX_NOTIFIER : _notifier().notifier,
    // TASK-004 — GET /me/permissions + the §6 anti-escalation check read the LIVE engine (the
    // resolver only consumes organizationId/userId from its context). Fixed-empty only when no
    // engine handle was passed (slice/tests) — never on the production mount.
    effectivePermissions: rbac
      ? ({ organizationId, userId }) =>
          rbac.resolver({ organizationId, userId } as Parameters<RbacEngineHandle["resolver"]>[0])
      : _fixedPerms([]).resolver,
    ...(rbac
      ? {
          rbacInvalidation: {
            invalidateActor: (orgId: string, userId: string) => rbac.invalidateActor(orgId, userId),
            invalidateOrg: (orgId: string) => rbac.invalidateOrg(orgId),
          },
        }
      : {}),
    audit: createTenantAuditExecutor(db),
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
export {
  type MembershipsHoldingPermissionReader,
  createMembershipsHoldingPermissionReader,
  type MembershipsHoldingRoleKeyReader,
  createMembershipsHoldingRoleKeyReader,
} from "./permission-holders";
// Org-explicit BATCHED role-key read (keys only), injected into other modules' route layers as a port at the composition
// root (e.g. M14's attendance trust: validating a discipline against the target member's real roles).
export {
  type MaterializerTx,
  type RoleTemplateMaterialization,
  materializeRoleTemplatesForOrg,
  materializeRoleTemplatesInTx,
} from "./role-template-materializer";
export {
  MEMBERSHIP_ROLE_KEYS_MAX_IDS,
  membershipRoleKeysForOrg,
} from "./membership-role-keys-for-org";
