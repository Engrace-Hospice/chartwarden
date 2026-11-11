// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-store-memory.ts — the in-memory wizard store.
//
// The slice twin the route inject tests and the service unit tests run against (the codebase's in-memory-twin
// convention): the same `WizardStore` contract as the Drizzle store, over plain maps. One state object is shared by every
// "transaction", so a test sees exactly what a sequence of calls left behind.
import { randomUUID } from "node:crypto";
import type {
  GoLiveAttestation,
  GoverningBaa,
  StepTask,
  StepTemplate,
  TaskStatus,
  TenantActor,
  TenantRef,
  WizardMember,
} from "./model";
import { GO_LIVE_DATA_CHANGED_REVOKE_REASON, GO_LIVE_TEMPLATE_KEY } from "./model";
import type { OrgProfile, OrgProfilePatch, OrgProfilePort } from "./org-profile";
import type { PlatformAuditEntry, TaskPatch, WizardRunner, WizardStore } from "./wizard-store";

/** An attestation row with the organisation the real table scopes it by. */
export type MemoryGoLive = GoLiveAttestation & { organizationId: string };

/** A BAA as the memory store keeps it: the writer and document fields are optional (absent = a legacy row). */
export type MemoryBaa = Pick<GoverningBaa, "baaStatus" | "expiresOn"> &
  Partial<Pick<GoverningBaa, "documentId" | "recordedByUserId" | "updatedByUserId">>;

export interface MemoryWizardState {
  tenants: TenantRef[];
  templates: StepTemplate[];
  tasks: (StepTask & { tenantAccountId: string; completionEvidence: Record<string, unknown> })[];
  goLive: MemoryGoLive[];
  baa: Map<string, MemoryBaa>;
  /** Memberships by id; a membership is visible only to its own organisation. */
  members: Map<string, WizardMember & { organizationId: string }>;
  activations: { tenantAccountId: string; actorMembershipId: string; reason: string }[];
  profiles: Map<string, OrgProfile>;
  /** Every platform transaction the runner opened: its reason label and the operator it acted for. */
  platformTransactions: { reason: string; actorUserId: string | null }[];
  /** The explicit platform audit entries a platform store recorded. */
  platformAudit: PlatformAuditEntry[];
  /** Users holding a live platform role in their home organisation (what `m34_platform_role_holders` reports). */
  platformStaffUserIds: Set<string>;
}

export function createMemoryWizardState(seed: Partial<MemoryWizardState> = {}): MemoryWizardState {
  return {
    tenants: [],
    templates: [],
    tasks: [],
    goLive: [],
    baa: new Map(),
    members: new Map(),
    activations: [],
    profiles: new Map(),
    platformTransactions: [],
    platformAudit: [],
    platformStaffUserIds: new Set(),
    ...seed,
  };
}

/** A membership of `organizationId` for the member map: active by default. */
export function memoryMember(
  organizationId: string,
  membershipId: string,
  userId: string,
  roleKeys: readonly string[],
  active = true,
): [string, MemoryWizardState["members"] extends Map<string, infer V> ? V : never] {
  return [membershipId, { membershipId, organizationId, userId, roleKeys, active }];
}

/** A task row for a tenant, defaulting every column the wizard reads. */
export function memoryTask(
  tenantAccountId: string,
  templateKey: string,
  status: TaskStatus = "pending",
  over: Partial<StepTask> = {},
): MemoryWizardState["tasks"][number] {
  return {
    id: randomUUID(),
    tenantAccountId,
    templateKey,
    status,
    assignedToMembershipId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    dueAt: null,
    startedAt: null,
    completedAt: null,
    blockerReason: null,
    evidenceNote: null,
    evidenceRef: null,
    attestedByMembershipId: null,
    attestedByActorKind: null,
    attestedAt: null,
    skipRationale: null,
    completionEvidence: {},
    ...over,
  };
}

function publicTask(row: MemoryWizardState["tasks"][number]): StepTask {
  const { tenantAccountId: _t, completionEvidence, ...task } = row;
  const skip = (completionEvidence.skip as { rationale?: string } | undefined)?.rationale ?? null;
  return { ...task, skipRationale: row.status === "skipped" ? skip : null };
}

export function createMemoryWizardStore(
  state: MemoryWizardState,
  allowActivate: boolean,
): WizardStore {
  return {
    async loadTenant(by) {
      return (
        state.tenants.find((t) =>
          "orgSlug" in by ? t.orgSlug === by.orgSlug : t.organizationId === by.organizationId,
        ) ?? null
      );
    },
    async listTemplates() {
      return [...state.templates];
    },
    async listTasks(tenantAccountId) {
      return state.tasks.filter((t) => t.tenantAccountId === tenantAccountId).map(publicTask);
    },
    async getCompletionEvidence(taskId) {
      return { ...(state.tasks.find((t) => t.id === taskId)?.completionEvidence ?? {}) };
    },
    async updateTask(taskId, expectedStatus, patch: TaskPatch) {
      const index = state.tasks.findIndex((t) => t.id === taskId && t.status === expectedStatus);
      if (index < 0) return null;
      const next = { ...(state.tasks[index] as MemoryWizardState["tasks"][number]) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (next as Record<string, unknown>)[key] = value;
      }
      state.tasks[index] = next;
      return publicTask(next);
    },
    async listGoLive(scope) {
      return state.goLive
        .filter(
          (g) =>
            g.tenantAccountId === scope.tenantAccountId &&
            g.organizationId === scope.organizationId,
        )
        .sort((a, b) => b.attestedAt.getTime() - a.attestedAt.getTime());
    },
    async insertGoLive(input) {
      // Strictly increasing: two attestations filed in the same millisecond must still order (the real table's
      // timestamptz is microsecond-resolution, so this never ties there).
      const last = state.goLive.reduce((max, g) => Math.max(max, g.attestedAt.getTime()), 0);
      const row: MemoryGoLive = {
        id: randomUUID(),
        organizationId: input.organizationId,
        tenantAccountId: input.tenantAccountId,
        status: "pending",
        attestedByMembershipId: input.attestedByMembershipId,
        attestedByUserId: input.attestedByUserId,
        attestedAt: new Date(Math.max(Date.now(), last + 1)),
        attestationNote: input.attestationNote,
        approvedByMembershipId: null,
        approvedByUserId: null,
        approvedAt: null,
        approvalReason: null,
        revokedByMembershipId: null,
        revokedByUserId: null,
        revokedAt: null,
        revokeReason: null,
      };
      state.goLive.push(row);
      return row;
    },
    async settleGoLive(organizationId, id, patch) {
      const index = state.goLive.findIndex(
        (g) => g.id === id && g.organizationId === organizationId && g.status === "pending",
      );
      if (index < 0) return null;
      const at = new Date();
      const current = state.goLive[index] as MemoryGoLive;
      const next: MemoryGoLive =
        patch.status === "approved"
          ? {
              ...current,
              status: "approved",
              approvedByMembershipId: patch.approvedByMembershipId,
              approvedByUserId: patch.approvedByUserId,
              approvedAt: at,
              approvalReason: patch.approvalReason,
            }
          : {
              ...current,
              status: "revoked",
              revokedByUserId: patch.revokedByUserId,
              revokedByMembershipId: patch.revokedByMembershipId,
              revokedAt: at,
              revokeReason: patch.revokeReason,
            };
      state.goLive[index] = next;
      return next;
    },
    async latestBaa(tenantAccountId) {
      const baa = state.baa.get(tenantAccountId);
      return baa
        ? {
            documentId: null,
            recordedByUserId: null,
            updatedByUserId: null,
            ...baa,
          }
        : undefined;
    },
    async setComplianceOfficer(tenantAccountId, membershipId) {
      state.tenants = state.tenants.map((t) =>
        t.tenantAccountId === tenantAccountId
          ? { ...t, complianceOfficerMembershipId: membershipId }
          : t,
      );
    },
    async recordPlatformAudit(entry) {
      if (!allowActivate) throw new Error("a tenant store cannot write a platform audit entry");
      state.platformAudit.push(entry);
    },
    async loadMember(organizationId, membershipId) {
      const member = state.members.get(membershipId);
      if (!member || member.organizationId !== organizationId) return null;
      const { organizationId: _org, ...visible } = member;
      return visible;
    },
    async lockOnboardingShared() {
      // One in-process "database": nothing runs concurrently with a memory transaction.
    },
    async lockOnboardingExclusive() {
      // One in-process "database": nothing runs concurrently with a memory transaction.
    },
    async updateOrgProfile(organizationId, patch) {
      const current = state.profiles.get(organizationId);
      const next: OrgProfile = {
        displayName: patch.displayName ?? current?.displayName ?? "",
        orgTimezone: patch.orgTimezone ?? current?.orgTimezone ?? "America/New_York",
      };
      state.profiles.set(organizationId, next);
      return next;
    },
    async voidPendingGoLiveForDataChange(input) {
      const index = state.goLive.findIndex(
        (g) => g.organizationId === input.organizationId && g.status === "pending",
      );
      if (index < 0) return false;
      state.goLive[index] = {
        ...(state.goLive[index] as MemoryGoLive),
        status: "revoked",
        revokedByUserId: input.revokedByUserId,
        // As the real helper: the membership is recorded only when it is the revoking user's active membership of THIS organisation.
        revokedByMembershipId: (() => {
          const member = input.revokedByMembershipId
            ? state.members.get(input.revokedByMembershipId)
            : undefined;
          return member?.organizationId === input.organizationId &&
            member.userId === input.revokedByUserId &&
            member.active
            ? member.membershipId
            : null;
        })(),
        revokedAt: new Date(),
        revokeReason: GO_LIVE_DATA_CHANGED_REVOKE_REASON,
      };
      const task = state.tasks.findIndex(
        (t) => t.templateKey === GO_LIVE_TEMPLATE_KEY && t.status === "in_progress",
      );
      if (task >= 0) {
        state.tasks[task] = {
          ...(state.tasks[task] as MemoryWizardState["tasks"][number]),
          status: "pending",
          startedAt: null,
        };
      }
      return true;
    },
    async isPlatformStaff(userId) {
      return state.platformStaffUserIds.has(userId);
    },
    async activate(input) {
      if (!allowActivate) throw new Error("a tenant store cannot activate a tenant");
      state.tenants = state.tenants.map((t) =>
        t.tenantAccountId === input.tenant.tenantAccountId ? { ...t, status: "active" } : t,
      );
      state.activations.push({
        tenantAccountId: input.tenant.tenantAccountId,
        actorMembershipId: input.actor.membershipId,
        reason: input.reason,
      });
    },
  };
}

export function createMemoryWizardRunner(state: MemoryWizardState): WizardRunner {
  return {
    inTenant: <T>(_actor: TenantActor, _org: string, fn: (store: WizardStore) => Promise<T>) =>
      fn(createMemoryWizardStore(state, false)),
    inPlatform: <T>(
      reason: string,
      fn: (store: WizardStore) => Promise<T>,
      actorUserId?: string,
    ) => {
      state.platformTransactions.push({ reason, actorUserId: actorUserId ?? null });
      return fn(createMemoryWizardStore(state, true));
    },
  };
}

export function createMemoryOrgProfile(state: MemoryWizardState): OrgProfilePort {
  return {
    async read(organizationId) {
      return state.profiles.get(organizationId) ?? null;
    },
    async update(organizationId, patch: OrgProfilePatch) {
      const next: OrgProfile = {
        displayName: patch.displayName ?? state.profiles.get(organizationId)?.displayName ?? "",
        orgTimezone:
          patch.orgTimezone ??
          state.profiles.get(organizationId)?.orgTimezone ??
          "America/New_York",
      };
      state.profiles.set(organizationId, next);
      return next;
    },
  };
}
