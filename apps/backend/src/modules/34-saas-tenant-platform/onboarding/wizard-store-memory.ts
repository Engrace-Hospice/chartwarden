// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-store-memory.ts — the in-memory wizard store.
//
// The slice twin the route inject tests and the service unit tests run against (the codebase's in-memory-twin
// convention): the same `WizardStore` contract as the Drizzle store, over plain maps. One state object is shared by every
// "transaction", so a test sees exactly what a sequence of calls left behind.
import { randomUUID } from "node:crypto";
import type {
  GoLiveAttestation,
  StepTask,
  StepTemplate,
  TaskStatus,
  TenantActor,
  TenantRef,
} from "./model";
import type { OrgProfile, OrgProfilePatch, OrgProfilePort } from "./org-profile";
import type { TaskPatch, WizardRunner, WizardStore } from "./wizard-store";

export interface MemoryWizardState {
  tenants: TenantRef[];
  templates: StepTemplate[];
  tasks: (StepTask & { tenantAccountId: string; completionEvidence: Record<string, unknown> })[];
  goLive: GoLiveAttestation[];
  baa: Map<string, { baaStatus: string; expiresOn: string | null }>;
  activeMembers: Set<string>;
  activations: { tenantAccountId: string; actorMembershipId: string; reason: string }[];
  profiles: Map<string, OrgProfile>;
}

export function createMemoryWizardState(seed: Partial<MemoryWizardState> = {}): MemoryWizardState {
  return {
    tenants: [],
    templates: [],
    tasks: [],
    goLive: [],
    baa: new Map(),
    activeMembers: new Set(),
    activations: [],
    profiles: new Map(),
    ...seed,
  };
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
    async listGoLive(tenantAccountId) {
      return state.goLive.filter((g) => g.tenantAccountId === tenantAccountId);
    },
    async insertGoLive(input) {
      const row: GoLiveAttestation = {
        id: randomUUID(),
        tenantAccountId: input.tenantAccountId,
        status: "pending",
        attestedByMembershipId: input.attestedByMembershipId,
        attestedAt: new Date(),
        attestationNote: input.attestationNote,
        approvedByMembershipId: null,
        approvedAt: null,
        approvalReason: null,
        revokedByMembershipId: null,
        revokedAt: null,
        revokeReason: null,
      };
      state.goLive.push(row);
      return row;
    },
    async settleGoLive(id, patch) {
      const index = state.goLive.findIndex((g) => g.id === id && g.status === "pending");
      if (index < 0) return null;
      const at = new Date();
      const current = state.goLive[index] as GoLiveAttestation;
      const next: GoLiveAttestation =
        patch.status === "approved"
          ? {
              ...current,
              status: "approved",
              approvedByMembershipId: patch.approvedByMembershipId,
              approvedAt: at,
              approvalReason: patch.approvalReason,
            }
          : {
              ...current,
              status: "revoked",
              revokedByMembershipId: patch.revokedByMembershipId,
              revokedAt: at,
              revokeReason: patch.revokeReason,
            };
      state.goLive[index] = next;
      return next;
    },
    async latestBaa(tenantAccountId) {
      return state.baa.get(tenantAccountId);
    },
    async setComplianceOfficer(tenantAccountId, membershipId) {
      state.tenants = state.tenants.map((t) =>
        t.tenantAccountId === tenantAccountId
          ? { ...t, complianceOfficerMembershipId: membershipId }
          : t,
      );
    },
    async isActiveMember(_organizationId, membershipId) {
      return state.activeMembers.has(membershipId);
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
    inPlatform: <T>(_reason: string, fn: (store: WizardStore) => Promise<T>) =>
      fn(createMemoryWizardStore(state, true)),
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
