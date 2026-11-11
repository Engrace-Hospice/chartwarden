// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-store-memory.ts — the in-memory help-request store + runner.
//
// The slice the route tests and the service's unit tests run on (the `wizard-store-memory.ts` precedent), and what
// `mountTenantPlatformRoutes` mounts when no database client is present. It enforces what the database does for the real store: the
// member's organization scoping (RLS), the one-live-request unique index, the status guards on every update. It is NOT the authority
// on any rule: the service is.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type {
  GrantRevocationSource,
  LinkedHelpRequestPort,
} from "@chartwarden/saas-tenant-platform";
import type { HelpRequestStatus, PlatformHelpRequestFilter } from "./help-request-contract";
import type {
  HelpApproval,
  HelpClosing,
  HelpGrantRow,
  HelpPageAfter,
  HelpRequestRow,
  HelpRequestRunner,
  HelpRequestStore,
  LinkedRequestDefaults,
  NewHelpRequest,
  PlatformHelpRequestRow,
} from "./help-request-store";

/** A tenant the memory slice knows: its account and how an operator sees it. */
export interface MemoryHelpTenant {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly orgSlug: string;
  readonly legalBusinessName: string;
}

/** Everything the memory store reads and writes, shared by every transaction (there is no isolation to model). */
export interface MemoryHelpState {
  readonly requests: Map<string, HelpRequestRow>;
  readonly tenants: Map<string, MemoryHelpTenant>;
  readonly grants: Map<string, HelpGrantRow>;
  /** Users the staff check answers true for (ChartWarden platform staff). */
  readonly staffUserIds: Set<string>;
  /** Membership ids that are NOT active (suspended or removed): every other membership counts as active. */
  readonly inactiveMembershipIds: Set<string>;
  /** The onboarding step keys a request may name. */
  readonly stepKeys: Set<string>;
  now: () => Date;
}

/** The default tenant the in-memory slice answers for, so a route test needs no setup. */
export const MEMORY_HELP_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const MEMORY_HELP_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

export function createMemoryHelpState(now: () => Date = () => new Date()): MemoryHelpState {
  const tenant: MemoryHelpTenant = {
    organizationId: MEMORY_HELP_ORG_ID,
    tenantAccountId: MEMORY_HELP_ACCOUNT_ID,
    orgSlug: "memory-tenant",
    legalBusinessName: "Memory Tenant Hospice",
  };
  return {
    requests: new Map(),
    tenants: new Map([[tenant.organizationId, tenant]]),
    grants: new Map(),
    staffUserIds: new Set(),
    inactiveMembershipIds: new Set(),
    stepKeys: new Set(["mac_configured", "payer_enrollment", "dosespot_kickoff_initiated"]),
    now,
  };
}

const { TENANT_HELP_REQUEST_LIVE_IDX } = schema;
const LIVE: ReadonlySet<HelpRequestStatus> = new Set(["open", "approved"]);

/** Newest first, by the keyset the SQL orders on: (requested_at DESC, id DESC). */
const newestFirst = (a: HelpRequestRow, b: HelpRequestRow): number =>
  a.cursorTs === b.cursorTs ? (a.id < b.id ? 1 : -1) : a.cursorTs < b.cursorTs ? 1 : -1;

const beforeCursor = (row: HelpRequestRow, after: HelpPageAfter | null): boolean =>
  after === null ||
  row.cursorTs < after.cursorTs ||
  (row.cursorTs === after.cursorTs && row.id < after.id);

function createStore(
  state: MemoryHelpState,
  scope: { organizationId: string | null },
  afterCommit: Array<() => Promise<void>>,
): HelpRequestStore {
  const visible = (row: HelpRequestRow | undefined): HelpRequestRow | null =>
    row && (scope.organizationId === null || row.organizationId === scope.organizationId)
      ? row
      : null;
  const put = (row: HelpRequestRow): HelpRequestRow => {
    state.requests.set(row.id, row);
    return row;
  };
  const withTenant = (row: HelpRequestRow): PlatformHelpRequestRow => {
    const tenant = state.tenants.get(row.organizationId);
    return {
      ...row,
      orgSlug: tenant?.orgSlug ?? "unknown",
      legalBusinessName: tenant?.legalBusinessName ?? "unknown",
    };
  };
  const close = (id: string, c: HelpClosing): HelpRequestRow | null => {
    const row = visible(state.requests.get(id));
    if (!row || row.status !== c.from) return null;
    return put({
      ...row,
      status: c.to,
      closedByActorKind: c.closedByActorKind,
      closedByUserId: c.closedByUserId,
      closedAt: c.closedAt,
      closeNote: c.closeNote,
    });
  };

  const linkedRequests = (defaults: LinkedRequestDefaults = {}): LinkedHelpRequestPort => ({
    async resolveForRevokedGrant(input) {
      const row = [...state.requests.values()].find(
        (r) =>
          r.supportConsentGrantId === input.grantId &&
          r.organizationId === input.organizationId &&
          r.status === "approved",
      );
      if (!row) return null;
      const closed = close(row.id, {
        from: "approved",
        to: "resolved",
        closedByActorKind: input.source,
        closedByUserId: input.closedByUserId ?? defaults.closedByUserId ?? null,
        closedAt: state.now(),
        closeNote: input.note ?? defaults.note ?? null,
      });
      return closed ? { helpRequestId: closed.id } : null;
    },
  });

  return {
    tx: {} as DbClient,
    async tenantAccountIdOf(organizationId) {
      return state.tenants.get(organizationId)?.tenantAccountId ?? null;
    },
    async isActiveMember(member) {
      return !state.inactiveMembershipIds.has(member.membershipId);
    },
    async isPlatformStaff(userId) {
      return state.staffUserIds.has(userId);
    },
    async stepKeyExists(key) {
      return state.stepKeys.has(key);
    },
    async findLive(tenantAccountId) {
      return (
        [...state.requests.values()].find(
          (r) => visible(r) !== null && r.tenantAccountId === tenantAccountId && LIVE.has(r.status),
        ) ?? null
      );
    },
    async listEnded(tenantAccountId, after, limit) {
      return [...state.requests.values()]
        .filter(
          (r) =>
            visible(r) !== null &&
            r.tenantAccountId === tenantAccountId &&
            !LIVE.has(r.status) &&
            beforeCursor(r, after),
        )
        .sort(newestFirst)
        .slice(0, limit);
    },
    async insert(input: NewHelpRequest) {
      const live = [...state.requests.values()].find(
        (r) => r.tenantAccountId === input.tenantAccountId && LIVE.has(r.status),
      );
      if (live) {
        // shaped like the pg error the real insert raises, so the service's race handling is exercised on this store too
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          constraint: TENANT_HELP_REQUEST_LIVE_IDX,
        });
      }
      const requestedAt = state.now();
      return put({
        id: randomUUID(),
        organizationId: input.organizationId,
        tenantAccountId: input.tenantAccountId,
        stepKey: input.stepKey,
        message: input.message,
        status: "open",
        requestedByMembershipId: input.requestedByMembershipId,
        requestedByUserId: input.requestedByUserId,
        requestedAt,
        cursorTs: requestedAt.toISOString(),
        supportConsentGrantId: null,
        approvedByMembershipId: null,
        approvedAt: null,
        closedByActorKind: null,
        closedByUserId: null,
        closedAt: null,
        closeNote: null,
        messagePurgedAt: null,
      });
    },
    async markApproved(id, approval: HelpApproval) {
      const row = visible(state.requests.get(id));
      if (!row || row.status !== "open") return null;
      return put({
        ...row,
        status: "approved",
        supportConsentGrantId: approval.grantId,
        approvedByMembershipId: approval.approvedByMembershipId,
        approvedAt: approval.approvedAt,
      });
    },
    async findForUpdate(id) {
      return visible(state.requests.get(id));
    },
    async markClosed(id, closing) {
      return close(id, closing);
    },
    afterCommit: (hook) => {
      afterCommit.push(hook);
    },
    async grantsById(grantIds) {
      return new Map(
        grantIds.flatMap((id) => {
          const grant = state.grants.get(id);
          return grant ? [[id, grant] as const] : [];
        }),
      );
    },
    linkedRequests,
    async listForPlatform(filter: PlatformHelpRequestFilter, after, limit) {
      return [...state.requests.values()]
        .filter(
          (r) =>
            (filter.statuses.length === 0 || filter.statuses.includes(r.status)) &&
            (filter.tenantAccountId === undefined ||
              r.tenantAccountId === filter.tenantAccountId) &&
            beforeCursor(r, after),
        )
        .sort(newestFirst)
        .slice(0, limit)
        .map(withTenant);
    },
    async findForPlatform(id) {
      const row = state.requests.get(id);
      return row ? withTenant(row) : null;
    },
    async cancelStaleOpen(olderThan, at) {
      let n = 0;
      for (const r of state.requests.values()) {
        if (r.status === "open" && r.requestedAt < olderThan) {
          close(r.id, systemEnding(r.status, "cancelled", at));
          n += 1;
        }
      }
      return n;
    },
    async purgeClosedText(retentionDays, at) {
      const cutoff = at.getTime() - retentionDays * 86_400_000;
      let n = 0;
      for (const r of state.requests.values()) {
        const closed = r.status === "resolved" || r.status === "cancelled";
        if (closed && r.messagePurgedAt === null && r.closedAt && r.closedAt.getTime() <= cutoff) {
          put({ ...r, message: null, closeNote: null, messagePurgedAt: at });
          n += 1;
        }
      }
      return n;
    },
    async resolveGrantEnded(at) {
      let n = 0;
      for (const r of state.requests.values()) {
        const grant = r.supportConsentGrantId ? state.grants.get(r.supportConsentGrantId) : null;
        if (r.status === "approved" && grant && (grant.revokedAt || grant.expiresAt <= at)) {
          close(r.id, systemEnding("approved", "resolved", at));
          n += 1;
        }
      }
      return n;
    },
  };
}

const systemEnding = (
  from: "open" | "approved",
  to: "resolved" | "cancelled",
  closedAt: Date,
): HelpClosing => ({
  from,
  to,
  closedByActorKind: "system" satisfies GrantRevocationSource,
  closedByUserId: null,
  closedAt,
  closeNote: null,
});

/** The runner over the memory state: the member's lane sees only their organization's rows, the platform lane sees all. */
export function createMemoryHelpRequestRunner(state: MemoryHelpState): HelpRequestRunner {
  const run = async <T>(
    scope: { organizationId: string | null },
    fn: (store: HelpRequestStore) => Promise<T>,
  ): Promise<T> => {
    const hooks: Array<() => Promise<void>> = [];
    const result = await fn(createStore(state, scope, hooks));
    // a unit of work that threw never reaches here: its hooks are dropped, as a rolled-back transaction's are
    for (const hook of hooks) await hook();
    return result;
  };
  return {
    asMember: (ctx, fn) => run({ organizationId: ctx.organizationId }, fn),
    asPlatform: (_ctx, fn) => run({ organizationId: null }, fn),
  };
}
