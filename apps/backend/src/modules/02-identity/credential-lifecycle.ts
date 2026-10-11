import { randomBytes } from "node:crypto";
import type { AuditContext, AuditExecutor } from "@wardenx/audit";
import { audit } from "@wardenx/audit";
import type { IdentityCredentialAdmin } from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type {
  MembershipRepository,
  ProposedRoleAttacher,
  ProposedRoleGuard,
  SessionWriter,
} from "./identity-ports";

export type CredentialState = "active" | "password_change_required";
export type CredentialStateReason = "admin_provisioned" | "admin_reset";

export interface CredentialLifecycleStore {
  organizationName(organizationId: string): Promise<string | null>;
  validateLocations(organizationId: string, locationIds: readonly string[]): Promise<boolean>;
  state(userId: string): Promise<{
    state: CredentialState;
    reason: string | null;
    version: number;
  } | null>;
  requirePasswordChange(userId: string, reason: CredentialStateReason): Promise<number | null>;
  completePasswordChange(userId: string, expectedVersion: number): Promise<boolean>;
  tenantResetEligibility(
    userId: string,
    organizationId: string,
  ): Promise<"eligible" | "not_member" | "shared_identity" | "inactive">;
}

export interface ProvisioningRoleResolver {
  resolveKeys(organizationId: string, roleIds: readonly string[]): Promise<readonly string[]>;
}

export interface UserProvisioningInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly name: string;
  readonly username: string;
  readonly email: string | null;
  readonly temporaryPassword: string;
  readonly roleIds: readonly string[];
  readonly defaultLocationIds: readonly string[];
  readonly auditContext: AuditContext;
}

export interface UserProvisioningResult {
  readonly userId: string;
  readonly membershipId: string;
  readonly name: string;
  readonly username: string;
  readonly email: string | null;
  readonly credentialState: "password_change_required";
  readonly roleIds: readonly string[];
  readonly defaultLocationIds: readonly string[];
}

export interface UserProvisioningService {
  provision(input: UserProvisioningInput): Promise<UserProvisioningResult>;
  resetPassword(input: {
    organizationId: string;
    actorUserId: string;
    targetUserId: string;
    temporaryPassword: string;
    auditContext: AuditContext;
  }): Promise<{ sessionsRevoked: true }>;
  resetPasswordGlobally(input: {
    actorUserId: string;
    targetUserId: string;
    temporaryPassword: string;
    auditContext: AuditContext;
  }): Promise<{ sessionsRevoked: true }>;
  completeRequiredChange(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    requestHeaders: Headers;
    auditContext: AuditContext;
  }): Promise<{ signInRequired: true }>;
}

export function generateTemporaryPassword(): string {
  // 192 random bits plus characters from each commonly accepted class; returned exactly once.
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

function credentialErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown; body?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.body?.code === "string") return candidate.body.code;
  return typeof candidate.message === "string" ? candidate.message : null;
}

function asPasswordPolicyError(error: unknown): WardenXError | null {
  const code = credentialErrorCode(error);
  if (!code) return null;
  if (["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "PASSWORD_COMPROMISED"].includes(code))
    return new WardenXError(code, "the password does not satisfy credential policy", 422);
  return null;
}

export function createDbCredentialLifecycleStore(db: DbClient): CredentialLifecycleStore {
  return {
    async organizationName(organizationId) {
      const [row] = await db
        .select({ name: schema.organizations.displayName })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId))
        .limit(1);
      return row?.name ?? null;
    },
    async validateLocations(organizationId, locationIds) {
      const wanted = [...new Set(locationIds)];
      if (wanted.length === 0) return true;
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .innerJoin(
            schema.providerEntities,
            eq(schema.providerEntities.id, schema.locations.providerEntityId),
          )
          .where(
            and(
              eq(schema.providerEntities.organizationId, organizationId),
              inArray(schema.locations.id, wanted),
              ne(schema.locations.status, "closed"),
            ),
          ),
      );
      return rows.length === wanted.length;
    },
    async state(userId) {
      const [row] = await db
        .select({
          state: schema.users.credentialState,
          reason: schema.users.credentialStateReason,
          version: schema.users.credentialVersion,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row ?? null;
    },
    async requirePasswordChange(userId, reason) {
      const rows = await db
        .update(schema.users)
        .set({
          credentialState: "password_change_required",
          credentialStateReason: reason,
          credentialVersion: sql`${schema.users.credentialVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.users.id, userId), ne(schema.users.status, "deactivated")))
        .returning({ version: schema.users.credentialVersion });
      return rows[0]?.version ?? null;
    },
    async completePasswordChange(userId, expectedVersion) {
      const rows = await db
        .update(schema.users)
        .set({
          credentialState: "active",
          credentialStateReason: null,
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.users.id, userId),
            eq(schema.users.credentialState, "password_change_required"),
            eq(schema.users.credentialVersion, expectedVersion),
          ),
        )
        .returning({ id: schema.users.id });
      return rows.length === 1;
    },
    async tenantResetEligibility(userId, organizationId) {
      const [user] = await db
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!user) return "not_member";
      if (user.status === "deactivated" || user.status === "suspended") return "inactive";
      const result = await db.execute(
        sql`SELECT organization_id, status FROM m2_list_own_memberships(${userId}::uuid)`,
      );
      const live = (
        result as unknown as { rows?: { organization_id: string; status: string }[] }
      ).rows?.filter((row) => row.status !== "revoked") ?? [];
      if (!live.some((row) => row.organization_id === organizationId)) return "not_member";
      if (live.some((row) => row.organization_id !== organizationId)) return "shared_identity";
      return "eligible";
    },
  };
}

export function createUserProvisioningService(deps: {
  credentials: IdentityCredentialAdmin;
  lifecycle: CredentialLifecycleStore;
  memberships: MembershipRepository;
  sessions: SessionWriter;
  roles: ProvisioningRoleResolver;
  roleGuard: ProposedRoleGuard;
  roleAttacher: ProposedRoleAttacher;
  audit: AuditExecutor;
}): UserProvisioningService {
  return {
    async provision(input) {
      if (input.roleIds.length === 0)
        throw new WardenXError("INVALID_ROLE", "at least one role is required", 422);
      const roleKeys = await deps.roles.resolveKeys(input.organizationId, input.roleIds);
      await deps.roleGuard.assertProposable({
        organizationId: input.organizationId,
        inviterUserId: input.actorUserId,
        roleKeys,
        auditContext: input.auditContext,
      });
      if (!(await deps.lifecycle.validateLocations(input.organizationId, input.defaultLocationIds)))
        throw new WardenXError("INVALID_LOCATION", "one or more locations are unavailable", 422);
      const organizationName = await deps.lifecycle.organizationName(input.organizationId);
      if (!organizationName) throw new WardenXError("NOT_FOUND", "organization not found", 404);

      let userId: string;
      try {
        ({ userId } = await deps.credentials.provision({
          name: input.name,
          username: input.username,
          email: input.email,
          password: input.temporaryPassword,
        }));
      } catch (error) {
        const policy = asPasswordPolicyError(error);
        if (policy) throw policy;
        // Deliberately does not reveal whether a username or email belongs to another tenant.
        throw new WardenXError("IDENTITY_CONFLICT", "the requested identity is unavailable", 409);
      }

      let membershipId: string | null = null;
      try {
        const membership = await deps.memberships.create({
          userId,
          organizationId: input.organizationId,
          organizationName,
          defaultLocationIds: [...input.defaultLocationIds],
        });
        membershipId = membership.membershipId;
        const attached = await deps.roleAttacher.attach({
          organizationId: input.organizationId,
          membershipId,
          roleKeys,
          grantedByUserId: input.actorUserId,
        });
        if (attached.unresolved.length > 0 || attached.attached.length !== roleKeys.length)
          throw new WardenXError("ROLE_ASSIGNMENT_FAILED", "roles could not be assigned", 409);
        await audit(deps.audit, input.auditContext, {
          eventType: "m2.user.provisioned",
          resourceKind: "user",
          resourceId: userId,
          outcome: "success",
          retentionClass: "compliance",
          after: {
            organizationId: input.organizationId,
            membershipId,
            roleIds: [...input.roleIds],
            credentialState: "password_change_required",
          },
        });
        return {
          userId,
          membershipId,
          name: input.name,
          username: input.username,
          email: input.email,
          credentialState: "password_change_required",
          roleIds: [...input.roleIds],
          defaultLocationIds: [...input.defaultLocationIds],
        };
      } catch (error) {
        if (membershipId)
          await Promise.resolve(deps.memberships.removeProvisioned(membershipId)).catch(
            () => undefined,
          );
        await deps.credentials.deleteProvisionedIdentity(userId).catch(() => undefined);
        throw error;
      }
    },

    async resetPassword(input) {
      const eligibility = await deps.lifecycle.tenantResetEligibility(
        input.targetUserId,
        input.organizationId,
      );
      if (eligibility === "not_member") throw new WardenXError("NOT_FOUND", "user not found", 404);
      if (eligibility === "shared_identity")
        throw new WardenXError(
          "SHARED_IDENTITY_RESET_RESTRICTED",
          "this global identity requires a platform-authorized reset",
          403,
        );
      if (eligibility === "inactive")
        throw new WardenXError("USER_INACTIVE", "inactive users cannot be reset", 409);
      const version = await deps.lifecycle.requirePasswordChange(input.targetUserId, "admin_reset");
      if (version === null) throw new WardenXError("NOT_FOUND", "user not found", 404);
      try {
        await deps.credentials.replacePassword(input.targetUserId, input.temporaryPassword);
      } catch (error) {
        throw asPasswordPolicyError(error) ?? error;
      }
      await audit(deps.audit, input.auditContext, {
        eventType: "m2.user.password_reset",
        resourceKind: "user",
        resourceId: input.targetUserId,
        outcome: "success",
        retentionClass: "compliance",
        after: { organizationId: input.organizationId, credentialVersion: version },
      });
      return { sessionsRevoked: true };
    },

    async resetPasswordGlobally(input) {
      const version = await deps.lifecycle.requirePasswordChange(input.targetUserId, "admin_reset");
      if (version === null) throw new WardenXError("NOT_FOUND", "user not found", 404);
      try {
        await deps.credentials.replacePassword(input.targetUserId, input.temporaryPassword);
      } catch (error) {
        throw asPasswordPolicyError(error) ?? error;
      }
      await audit(deps.audit, input.auditContext, {
        eventType: "m2.user.password_reset",
        resourceKind: "user",
        resourceId: input.targetUserId,
        outcome: "success",
        retentionClass: "compliance",
        after: { scope: "platform", credentialVersion: version },
      });
      return { sessionsRevoked: true };
    },

    async completeRequiredChange(input) {
      const current = await deps.lifecycle.state(input.userId);
      if (!current || current.state !== "password_change_required")
        throw new WardenXError("CREDENTIAL_ALREADY_ROTATED", "password change is not required", 409);
      try {
        await deps.credentials.changeOwnPassword({
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          requestHeaders: input.requestHeaders,
        });
      } catch (error) {
        const policy = asPasswordPolicyError(error);
        if (policy) throw policy;
        throw new WardenXError("INVALID_CURRENT_PASSWORD", "password change was refused", 400);
      }
      const completed = await deps.lifecycle.completePasswordChange(input.userId, current.version);
      await deps.sessions.revokeAllForUser(input.userId);
      if (!completed)
        throw new WardenXError(
          "CREDENTIAL_STATE_CHANGED",
          "credential state changed concurrently; sign in and retry",
          409,
        );
      await audit(deps.audit, input.auditContext, {
        eventType: "m2.user.password_change_completed",
        resourceKind: "user",
        resourceId: input.userId,
        outcome: "success",
        retentionClass: "compliance",
        after: { credentialVersion: current.version },
      });
      return { signInRequired: true };
    },
  };
}
