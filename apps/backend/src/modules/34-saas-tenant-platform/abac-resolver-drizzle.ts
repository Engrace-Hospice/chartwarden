// apps/backend/src/modules/34-saas-tenant-platform/abac-resolver-drizzle.ts — M34 (§4.6, GAP-098).
//
// The Drizzle-backed {@link TenantPlatformAbacResolver} the §4.6 predicates load owner facts through. Before
// this existed production bound a deny-all resolver, so support-session start/elevate and feature-flag
// writes (the kill switch included) answered 403 for every caller, including a platform_ops operator
// holding a valid consent grant.
//
// SCOPING. The platform_ops actor's own organization is NOT the tenant whose grant/session it works on, so
// the grant and session reads run under `withPlatformContext` (the separately-pooled, AUDITED cross-tenant
// path; every evaluation leaves a `platform.bypass_invoked` row). The onboarding-task read is tenant-scoped
// and runs under `withOrgContext` so RLS, not this WHERE clause, is the isolation floor.
//
// FAIL CLOSED. Every method swallows its own error into the deny answer (null/false): a guard that 500s on a
// database blip is worse than one that denies, and no throw may be read as an allow. A grant is "active"
// only when unrevoked and unexpired at `now()`; a session only when unclosed and unexpired.
//
// `feature_flag` belongs to M1, so the flag rows arrive through an injected loader the composition root
// builds over M1's own store (the same arrangement as M1's flag admin seam), not a schema import here.
import type { DbClient } from "@chartwarden/db";
import {
  OnboardingRepository,
  SupportRepository,
  TenantAccountRepository,
} from "@chartwarden/saas-tenant-platform";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import type {
  FeatureFlagFacts,
  OnboardingTaskFacts,
  SupportConsentGrantFacts,
  TenantPlatformAbacResolver,
} from "./abac-predicates";
import { M34_PLATFORM_JOB_ID } from "./wiring";

type Tx = DbClient;

/** A consent grant row, narrowed to the columns the predicates resolve. */
export interface GrantRow {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly grantorMembershipId: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

/** A support session row, narrowed to the columns the predicates resolve. */
export interface OpenSessionRow {
  readonly id: string;
  readonly supportConsentGrantId: string;
  readonly actorMembershipId: string;
  readonly expiresAt: Date;
}

/** An onboarding task row, narrowed to the columns the predicates resolve. */
export interface OnboardingTaskRow {
  readonly taskId: string;
  readonly organizationId: string;
  readonly assignedToMembershipId: string | null;
}

/** The tx-bound row reads (a port so the matrix is unit-testable without a database). */
export interface PlatformFactsReader {
  findGrant(grantId: string): Promise<GrantRow | null>;
  /** Not-yet-closed sessions for the tenant (expiry is judged by the resolver against `now()`). */
  listOpenSessions(tenantAccountId: string): Promise<readonly OpenSessionRow[]>;
  findOnboardingTask(taskId: string): Promise<OnboardingTaskRow | null>;
  /** Does `organizationId` belong to a provisioned tenant account? (scope validation for flag creation) */
  organizationHasTenantAccount(organizationId: string): Promise<boolean>;
}

export interface DrizzleTenantPlatformAbacResolverDeps {
  /** Run `fn` in one audited platform-context tx. */
  readonly runPlatform: <T>(reason: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Run `fn` under the acting org's `withOrgContext`. */
  readonly runOrg: <T>(organizationId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Tx-bound row readers (defaults to the M34 repositories). */
  readonly reader?: (tx: Tx) => PlatformFactsReader;
  /** Every `feature_flag` row for `flagKey` (global + tenant), from M1's flag store. */
  readonly loadFlagRows: (
    flagKey: string,
  ) => Promise<readonly { readonly organizationId: string | null }[]>;
  readonly now?: () => Date;
}

/** Production readers over the M34 repositories. */
export function repositoryFactsReader(tx: Tx): PlatformFactsReader {
  const support = new SupportRepository(tx);
  const onboarding = new OnboardingRepository(tx);
  const tenants = new TenantAccountRepository(tx);
  return {
    async organizationHasTenantAccount(organizationId) {
      return (await tenants.findByOrganizationId(organizationId)) !== null;
    },
    findGrant: (grantId) => support.findConsentGrantById(grantId),
    async listOpenSessions(tenantAccountId) {
      const rows = await support.listOpenSessions(tenantAccountId);
      return rows.map((s) => ({
        id: s.id,
        supportConsentGrantId: s.supportConsentGrantId,
        actorMembershipId: s.actorMembershipId,
        expiresAt: s.expiresAt,
      }));
    },
    async findOnboardingTask(taskId) {
      const row = await onboarding.findTaskById(taskId);
      return row
        ? {
            taskId: row.id,
            organizationId: row.organizationId,
            assignedToMembershipId: row.assignedToMembershipId,
          }
        : null;
    },
  };
}

const grantActive = (grant: GrantRow, now: Date): boolean =>
  grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime();

export function createDrizzleTenantPlatformAbacResolver(
  deps: DrizzleTenantPlatformAbacResolverDeps,
): TenantPlatformAbacResolver {
  const readerOf = deps.reader ?? repositoryFactsReader;
  const now = deps.now ?? (() => new Date());

  return {
    async hasActiveConsentedSupportSession(input) {
      try {
        const at = now();
        return await deps.runPlatform("m34 abac: active consented support session", async (tx) => {
          const reader = readerOf(tx);
          const sessions = await reader.listOpenSessions(input.tenantAccountId);
          for (const session of sessions) {
            if (session.actorMembershipId !== input.actorMembershipId) continue;
            if (session.expiresAt.getTime() <= at.getTime()) continue;
            const grant = await reader.findGrant(session.supportConsentGrantId);
            if (
              grant &&
              grant.tenantAccountId === input.tenantAccountId &&
              grantActive(grant, at)
            ) {
              return true;
            }
          }
          return false;
        });
      } catch {
        return false;
      }
    },

    async loadConsentGrant(_organizationId, grantId): Promise<SupportConsentGrantFacts | null> {
      try {
        const at = now();
        return await deps.runPlatform("m34 abac: load support consent grant", async (tx) => {
          const grant = await readerOf(tx).findGrant(grantId);
          if (!grant) return null;
          return {
            grantId: grant.id,
            tenantAccountId: grant.tenantAccountId,
            grantorMembershipId: grant.grantorMembershipId,
            active: grantActive(grant, at),
          };
        });
      } catch {
        return null;
      }
    },

    async loadFeatureFlag(
      _organizationId,
      flagKey,
      scopeOrganizationId = null,
    ): Promise<FeatureFlagFacts | null> {
      try {
        const rows = await deps.loadFlagRows(flagKey);
        // Resolve at the EXACT requested scope: a same-key row in any other scope (a global row, another
        // tenant's row) neither shadows nor stands in for it.
        if (rows.some((r) => r.organizationId === scopeOrganizationId)) {
          return { flagKey, organizationId: scopeOrganizationId, exists: true };
        }
        if (scopeOrganizationId === null) {
          return { flagKey, organizationId: null, exists: false }; // first-time global creation
        }
        // Absent key in a tenant scope: valid only for a real, provisioned tenant (server-validated — the
        // body's organizationId is never trusted on its own).
        const known = await deps.runPlatform("m34 abac: validate flag scope tenant", (tx) =>
          readerOf(tx).organizationHasTenantAccount(scopeOrganizationId),
        );
        return known ? { flagKey, organizationId: scopeOrganizationId, exists: false } : null;
      } catch {
        return null;
      }
    },

    async loadOnboardingTask(organizationId, taskId): Promise<OnboardingTaskFacts | null> {
      try {
        return await deps.runOrg(organizationId, async (tx) => {
          const task = await readerOf(tx).findOnboardingTask(taskId);
          if (!task || task.organizationId !== organizationId) return null;
          return { taskId: task.taskId, assignedToMembershipId: task.assignedToMembershipId };
        });
      } catch {
        return null;
      }
    },
  };
}

/** Bind the resolver's runners to M1's tenancy contexts over the platform and tenant pools. */
export function buildDrizzleTenantPlatformAbacResolver(deps: {
  readonly db: DbClient;
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly loadFlagRows: DrizzleTenantPlatformAbacResolverDeps["loadFlagRows"];
}): TenantPlatformAbacResolver {
  return createDrizzleTenantPlatformAbacResolver({
    runPlatform: <T>(reason: string, fn: (tx: Tx) => Promise<T>) =>
      withPlatformContext<Tx, T>(
        deps.platformDb,
        { jobId: M34_PLATFORM_JOB_ID, reason, crossTenant: true },
        deps.auditBypass,
        fn,
      ),
    runOrg: (organizationId, fn) =>
      withOrgContext(deps.db, { organizationId, userId: "" }, (tx) => fn(tx as Tx)),
    loadFlagRows: deps.loadFlagRows,
  });
}
