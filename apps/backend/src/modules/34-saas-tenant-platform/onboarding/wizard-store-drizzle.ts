import { randomUUID } from "node:crypto";
// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-store-drizzle.ts — the wizard over Drizzle.
//
// `createDrizzleWizardStore(tx)` binds the `WizardStore` port to ONE open transaction; `createDrizzleWizardRunner` opens
// that transaction the right way for each surface: the tenant surface inside the actor's own `withOrgContext` (RLS on
// `app.org_id`, as the real NOBYPASSRLS app role), the platform surface inside an audited `withPlatformContext`. M34 owns
// every table touched here except the M1 spine reads (`organization` for the slug, `membership` for the officer check),
// which the table-ownership gate sanctions.
import { auditPlatformEvent } from "@chartwarden/audit";
import { PLATFORM_GRANTABLE_ROLE_KEYS } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { BaaRegisterRepository, OnboardingRepository } from "@chartwarden/saas-tenant-platform";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { pickGoverningBaa } from "../routes/platform/activation-guards";
import { lockTenantOnboardingShared } from "../routes/platform/tenant-onboarding-lock";
import { voidPendingGoLiveForDataChange as voidPendingGoLive } from "./go-live-void";
import type {
  CompletionMode,
  GoLiveAttestation,
  PlatformActor,
  StepOwner,
  StepTask,
  StepTemplate,
  TaskStatus,
  TenantRef,
  WizardMember,
} from "./model";
import type { OrgProfilePort } from "./org-profile";
import type { TaskPatch, WizardRunner, WizardStore } from "./wizard-store";

/** onboarding -> active inside the caller's transaction (built by the platform backend: it owns the lifecycle machine). */
export type WizardActivation = (
  tx: DbClient,
  input: {
    readonly tenant: TenantRef;
    readonly actor: PlatformActor;
    readonly reason: string;
    readonly tasksCompleted: number;
    readonly tasksSkipped: number;
  },
) => Promise<void>;

/** The org-profile port bound to ONE open transaction (its own `withOrgContext` then nests as a savepoint in it). */
export type OrgProfilePortFor = (tx: DbClient) => OrgProfilePort;

const T = schema.onboardingTaskTemplate;
const K = schema.onboardingTask;
const G = schema.tenantGoLiveAttestation;
const A = schema.tenantAccount;

const toTemplate = (row: schema.OnboardingTaskTemplate): StepTemplate => ({
  key: row.key,
  title: row.displayLabel,
  description: row.description,
  sequence: row.canonicalOrder,
  owner: row.requiredRole as StepOwner,
  completionMode: row.completionMode as CompletionMode,
  optional: row.isOptional,
  canonical: row.isCanonical,
});

const toTask = (row: schema.OnboardingTask): StepTask => ({
  id: row.id,
  templateKey: row.templateKey,
  status: row.status as TaskStatus,
  assignedToMembershipId: row.assignedToMembershipId,
  createdAt: row.createdAt,
  dueAt: row.dueAt,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  blockerReason: row.blockerReason,
  evidenceNote: row.evidenceNote,
  evidenceRef: row.evidenceRef,
  attestedByMembershipId: row.attestedByMembershipId,
  attestedByActorKind: row.attestedByActorKind as StepTask["attestedByActorKind"],
  attestedAt: row.attestedAt,
  skipRationale:
    row.status === "skipped"
      ? ((row.completionEvidence as { skip?: { rationale?: string } } | null)?.skip?.rationale ??
        null)
      : null,
});

const toGoLive = (row: schema.TenantGoLiveAttestation): GoLiveAttestation => ({
  id: row.id,
  tenantAccountId: row.tenantAccountId,
  status: row.status,
  attestedByMembershipId: row.attestedByMembershipId,
  attestedByUserId: row.attestedByUserId,
  attestedAt: row.attestedAt,
  attestationNote: row.attestationNote,
  approvedByMembershipId: row.approvedByMembershipId,
  approvedByUserId: row.approvedByUserId,
  approvedAt: row.approvedAt,
  approvalReason: row.approvalReason,
  revokedByMembershipId: row.revokedByMembershipId,
  revokedByUserId: row.revokedByUserId,
  revokedAt: row.revokedAt,
  revokeReason: row.revokeReason,
});

/** `date` columns round-trip as `YYYY-MM-DD` strings (Drizzle date mode); tolerate a Date all the same. */
const dateOnly = (v: string | Date | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString().slice(0, 10);

export function createDrizzleWizardStore(
  tx: DbClient,
  activation?: WizardActivation,
  orgProfileFor?: OrgProfilePortFor,
): WizardStore {
  const repo = new OnboardingRepository(tx);
  return {
    async loadTenant(by) {
      const [row] = await tx
        .select({ account: A, slug: schema.organizations.slug })
        .from(A)
        .innerJoin(schema.organizations, eq(A.organizationId, schema.organizations.id))
        .where(
          "orgSlug" in by
            ? eq(schema.organizations.slug, by.orgSlug)
            : eq(A.organizationId, by.organizationId),
        )
        .limit(1);
      return row
        ? {
            tenantAccountId: row.account.id,
            organizationId: row.account.organizationId,
            orgSlug: row.slug,
            status: row.account.status,
            legalBusinessName: row.account.legalBusinessName,
            complianceOfficerMembershipId: row.account.complianceOfficerMembershipId,
          }
        : null;
    },
    async listTemplates() {
      return (await repo.listTemplates()).map(toTemplate);
    },
    async listTasks(tenantAccountId) {
      return (await repo.listTasksByTenant(tenantAccountId)).map(toTask);
    },
    async getCompletionEvidence(taskId) {
      const [row] = await tx
        .select({ evidence: K.completionEvidence })
        .from(K)
        .where(eq(K.id, taskId))
        .limit(1);
      return (row?.evidence as Record<string, unknown> | undefined) ?? {};
    },
    async updateTask(taskId, expectedStatus, patch: TaskPatch) {
      const [row] = await tx
        .update(K)
        .set({ ...patch })
        .where(and(eq(K.id, taskId), eq(K.status, expectedStatus)))
        .returning();
      return row ? toTask(row) : null;
    },
    async listGoLive(scope) {
      const rows = await tx
        .select()
        .from(G)
        .where(
          and(
            eq(G.tenantAccountId, scope.tenantAccountId),
            eq(G.organizationId, scope.organizationId),
          ),
        )
        .orderBy(desc(G.attestedAt));
      return rows.map(toGoLive);
    },
    async insertGoLive(input) {
      const [row] = await tx
        .insert(G)
        .values({
          organizationId: input.organizationId,
          tenantAccountId: input.tenantAccountId,
          attestedByMembershipId: input.attestedByMembershipId,
          attestedByUserId: input.attestedByUserId,
          attestationNote: input.attestationNote,
        })
        .returning();
      if (!row) throw new Error("tenant_go_live_attestation insert returned no row");
      return toGoLive(row);
    },
    async settleGoLive(organizationId, id, patch) {
      const at = new Date();
      const set =
        patch.status === "approved"
          ? {
              status: "approved" as const,
              approvedByMembershipId: patch.approvedByMembershipId,
              approvedByUserId: patch.approvedByUserId,
              approvedAt: at,
              approvalReason: patch.approvalReason,
              updatedAt: at,
            }
          : {
              status: "revoked" as const,
              revokedByUserId: patch.revokedByUserId,
              revokedByMembershipId: patch.revokedByMembershipId,
              revokedAt: at,
              revokeReason: patch.revokeReason,
              updatedAt: at,
            };
      const [row] = await tx
        .update(G)
        .set(set)
        .where(and(eq(G.id, id), eq(G.organizationId, organizationId), eq(G.status, "pending")))
        .returning();
      return row ? toGoLive(row) : null;
    },
    async latestBaa(tenantAccountId) {
      const rows = await new BaaRegisterRepository(tx).listByTenantAccountId(tenantAccountId);
      const baa = pickGoverningBaa(rows);
      return baa
        ? {
            baaStatus: baa.baaStatus,
            expiresOn: dateOnly(baa.expiresOn),
            documentId: baa.documentId,
            recordedByUserId: baa.recordedByUserId,
            updatedByUserId: baa.updatedByUserId,
          }
        : undefined;
    },
    async setComplianceOfficer(tenantAccountId, membershipId) {
      await tx
        .update(A)
        .set({ complianceOfficerMembershipId: membershipId, updatedAt: new Date() })
        .where(eq(A.id, tenantAccountId));
    },
    async recordPlatformAudit(entry) {
      await auditPlatformEvent(tx, {
        eventType: entry.eventType,
        resourceKind: "tenant_account",
        resourceId: entry.tenantAccountId,
        outcome: "success",
        severity: "warn",
        correlationId: `m34-onboarding:${entry.eventType}:${entry.tenantAccountId}:${randomUUID()}`,
        context: {
          organizationId: entry.organizationId,
          operatorUserId: entry.operator.userId,
          operatorMembershipId: entry.operator.membershipId,
          reason: entry.reason,
          ...entry.detail,
        },
      });
    },
    async loadMember(organizationId, membershipId): Promise<WizardMember | null> {
      const [member] = await tx
        .select({
          userId: schema.memberships.userId,
          status: schema.memberships.status,
        })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.id, membershipId),
            eq(schema.memberships.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!member) return null;
      // The roles it holds NOW: an enabled role, a grant that has not expired. Explicit columns only: the platform
      // credential holds column-level SELECT on exactly these.
      const held = await tx
        .select({ key: schema.roles.key })
        .from(schema.membershipRoles)
        .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
        .where(
          and(
            eq(schema.membershipRoles.membershipId, membershipId),
            eq(schema.membershipRoles.organizationId, organizationId),
            eq(schema.roles.enabled, true),
            or(
              isNull(schema.membershipRoles.expiresAt),
              gt(schema.membershipRoles.expiresAt, sql`now()`),
            ),
          ),
        );
      return {
        membershipId,
        userId: member.userId,
        active: member.status === "active",
        roleKeys: held.map((r) => r.key),
      };
    },
    async lockOnboardingShared(organizationId) {
      await lockTenantOnboardingShared(tx, organizationId);
    },
    async updateOrgProfile(organizationId, patch, actorUserId) {
      if (!orgProfileFor) throw new Error("this wizard store has no org profile port");
      return orgProfileFor(tx).update(organizationId, patch, actorUserId);
    },
    voidPendingGoLiveForDataChange: (input) => voidPendingGoLive(tx, input),
    async isPlatformStaff(userId) {
      const holders = await tx.execute<{ user_id: string }>(
        sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${sql.join(
          PLATFORM_GRANTABLE_ROLE_KEYS.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]) WHERE user_id = ${userId}::uuid`,
      );
      return holders.rows.length > 0;
    },
    async activate(input) {
      if (!activation) throw new Error("a tenant-scoped wizard store cannot activate a tenant");
      await activation(tx, input);
    },
  };
}

export interface DrizzleWizardRunnerDeps {
  /** The tenant pool (the real NOBYPASSRLS app role). */
  readonly db: DbClient;
  /** The audited BYPASSRLS platform credential. */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
  readonly activation: WizardActivation;
  /** The org-profile write, bound to the wizard's own transaction so the status check, the write and the void share it. */
  readonly orgProfileFor: OrgProfilePortFor;
}

export function createDrizzleWizardRunner(deps: DrizzleWizardRunnerDeps): WizardRunner {
  return {
    inTenant: (actor, organizationId, fn) =>
      withOrgContext(deps.db, { organizationId, userId: actor.userId }, (tx) =>
        fn(createDrizzleWizardStore(tx as unknown as DbClient, undefined, deps.orgProfileFor)),
      ),
    inPlatform: <T>(reason: string, fn: (store: WizardStore) => Promise<T>, actorUserId?: string) =>
      withPlatformContext<DbClient, T>(
        deps.platformDb,
        { jobId: deps.platformJobId, reason, crossTenant: true },
        deps.auditBypass,
        async (tx) => {
          // withPlatformContext sets no actor. Without app.user_id the row-audit triggers record these writes with a NULL
          // actor_user_id, so the operator who made them would be nameless in the trail.
          if (actorUserId)
            await tx.execute(sql`SELECT set_config('app.user_id', ${actorUserId}, true)`);
          return fn(createDrizzleWizardStore(tx, deps.activation));
        },
      ),
  };
}
