// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-store.ts — what the wizard needs from storage.
//
// The business rules (sequence, owner, attestation, go-live) live in wizard-service.ts and run against this port, so the
// same code serves the tenant surface (an org-scoped transaction) and the platform surface (an audited platform
// transaction), over Drizzle in production and over memory in tests. A store is bound to ONE open transaction.
import type {
  GoLiveAttestation,
  GoverningBaa,
  PlatformActor,
  StepTask,
  StepTemplate,
  TaskStatus,
  TenantActor,
  TenantRef,
  WizardMember,
} from "./model";
import type { OrgProfile, OrgProfilePatch } from "./org-profile";

/** Columns a service call may change on a task. `completionEvidence` replaces the jsonb bag (the caller merges). */
export interface TaskPatch {
  readonly status?: TaskStatus;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly blockerReason?: string | null;
  readonly evidenceNote?: string | null;
  readonly evidenceRef?: string | null;
  readonly attestedByMembershipId?: string | null;
  readonly attestedByActorKind?: "platform_ops" | "tenant" | null;
  readonly attestedAt?: Date | null;
  readonly completionEvidence?: Record<string, unknown>;
}

/**
 * One structured audit row for a platform action the row-level audit trigger cannot describe on its own: WHO did it (the
 * operator's user and membership), to WHICH organisation, and WHY. `detail` carries ids only, never free text.
 */
export interface PlatformAuditEntry {
  readonly eventType: string;
  readonly tenantAccountId: string;
  readonly organizationId: string;
  readonly operator: { readonly userId: string; readonly membershipId: string };
  readonly reason: string;
  readonly detail: Readonly<Record<string, string | null>>;
}

/** What scopes a tenant's attestations: the tenant account AND its organisation. */
export type GoLiveScope = Pick<TenantRef, "tenantAccountId" | "organizationId">;

export interface WizardStore {
  loadTenant(
    by: { readonly orgSlug: string } | { readonly organizationId: string },
  ): Promise<TenantRef | null>;
  /** ACTIVE templates only, in any order. */
  listTemplates(): Promise<StepTemplate[]>;
  /** The tenant's tasks for active templates. */
  listTasks(tenantAccountId: string): Promise<StepTask[]>;
  /** The task's raw `completion_evidence` bag (so a re-open can keep the history). */
  getCompletionEvidence(taskId: string): Promise<Record<string, unknown>>;
  /** Compare-and-set on the status read: null when the task changed underneath the caller. */
  updateTask(
    taskId: string,
    expectedStatus: TaskStatus,
    patch: TaskPatch,
  ): Promise<StepTask | null>;
  /** The tenant's go-live attestations, newest first. Scoped by organisation as well as tenant, whatever the connection. */
  listGoLive(tenant: GoLiveScope): Promise<GoLiveAttestation[]>;
  insertGoLive(input: {
    readonly organizationId: string;
    readonly tenantAccountId: string;
    readonly attestedByMembershipId: string;
    readonly attestedByUserId: string;
    readonly attestationNote: string | null;
  }): Promise<GoLiveAttestation>;
  /** Moves a PENDING attestation of the organisation to approved or revoked; null when it was no longer pending. */
  settleGoLive(
    organizationId: string,
    id: string,
    patch:
      | {
          readonly status: "approved";
          readonly approvedByMembershipId: string;
          readonly approvedByUserId: string;
          readonly approvalReason: string;
        }
      | {
          readonly status: "revoked";
          readonly revokedByUserId: string;
          readonly revokedByMembershipId: string | null;
          readonly revokeReason: string;
        },
  ): Promise<GoLiveAttestation | null>;
  /** The governing BAA (newest dated; an undated termination wins), or undefined. */
  latestBaa(tenantAccountId: string): Promise<GoverningBaa | undefined>;
  setComplianceOfficer(tenantAccountId: string, membershipId: string): Promise<void>;
  /** Writes `entry` as a platform-scoped audit event, atomically with the change it describes (platform stores only). */
  recordPlatformAudit(entry: PlatformAuditEntry): Promise<void>;
  /**
   * Takes the SHARED onboarding lock (held until this transaction ends), so "the tenant is still onboarding" stays true for the
   * write that follows: go-live approval takes the same lock EXCLUSIVE. Call it before reading the status you act on.
   */
  lockOnboardingShared(organizationId: string): Promise<void>;
  /** Writes the validated org profile patch inside THIS transaction (through the M1/M2 port) and returns the stored profile. */
  updateOrgProfile(
    organizationId: string,
    patch: OrgProfilePatch,
    actorUserId: string,
  ): Promise<OrgProfile>;
  /**
   * Revokes the organisation's pending go-live attestation because onboarding data changed after it was attested (true when
   * one was voided), inside THIS transaction. The attestation stated the data was ready; a change makes that statement stale.
   */
  voidPendingGoLiveForDataChange(input: {
    readonly organizationId: string;
    readonly revokedByUserId: string;
    readonly revokedByMembershipId: string | null;
  }): Promise<boolean>;
  /** The membership as it is now (user, liveness, roles), or null when it is not a membership of the organisation. */
  loadMember(organizationId: string, membershipId: string): Promise<WizardMember | null>;
  /**
   * Whether the user holds a live platform role (platform_ops, platform_admin, ...) in their home organisation: ChartWarden staff.
   * Answered by M34's SECURITY DEFINER holder reader on either pool; a tenant role cannot see another organisation's grants.
   */
  isPlatformStaff(userId: string): Promise<boolean>;
  /**
   * onboarding -> active through the lifecycle machine, inside this same transaction (platform stores only: a tenant
   * store refuses). Publishes `m34.tenant.onboarding_completed`.
   */
  activate(input: {
    readonly tenant: TenantRef;
    readonly actor: PlatformActor;
    readonly reason: string;
    readonly tasksCompleted: number;
    readonly tasksSkipped: number;
  }): Promise<void>;
}

/** Opens one transaction and hands the callback a store bound to it. */
export interface WizardRunner {
  inTenant<T>(
    actor: TenantActor,
    organizationId: string,
    fn: (store: WizardStore) => Promise<T>,
  ): Promise<T>;
  /**
   * `actorUserId` is the operator the transaction acts for: the Drizzle runner sets it as `app.user_id`, so every
   * row-audit trigger that records an actor (onboarding_task, tenant_account) names the person, not a null.
   * `withPlatformContext` itself records only the job id and the reason label.
   */
  inPlatform<T>(
    reason: string,
    fn: (store: WizardStore) => Promise<T>,
    actorUserId?: string,
  ): Promise<T>;
}
