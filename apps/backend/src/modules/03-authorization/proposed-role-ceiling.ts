// apps/backend/src/modules/03-authorization/proposed-role-ceiling.ts — GAP-008: an invitation may not
// carry a role above its INVITER's ceiling.
//
// WHY THIS EXISTS. `POST /orgs/:id/invitations` gated on `member.invite` alone and stored
// `proposedRoleKeys` after a shape check; on accept `createDbProposedRoleAttacher` inserted a
// `membership_role` row for any enabled org role (org_admin included) with `grantedBy` = the INVITEE. The
// §6 anti-escalation check lived only on the direct `POST /memberships/:id/roles` route, so a tenant
// custom role holding `member.invite` could mint an org_admin by inviting a colluding address.
//
// THE RULE (the same one the assign route enforces, applied where the proposal is made AND again where
// it is honoured, because the inviter's permissions and the role's permissions can both change in the
// 72 h between the two):
//   1. proposing any role requires the inviter to hold `role.assign`;
//   2. a reserved platform role (GAP-003/GAP-096) is never proposable;
//   3. every permission the role grants must be one the inviter holds (§6 anti-escalation).
import type { AuditContext, AuditExecutor } from "@chartwarden/audit";
import { isReservedPlatformRoleKey, isTenantRoleReserved } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { auditEscalationBlocked } from "./audit/authz-audit";
import type { ActorPermissionResolver } from "./authz-ports";

const FORBIDDEN_STATUS = 403;

/** The permission that gates attaching any role to a membership. */
export const ROLE_ASSIGN_PERMISSION = "role.assign";

/** An org role a proposal names, with the permissions it would confer. */
export interface ProposableRole {
  readonly id: string;
  readonly key: string;
  readonly category: string;
  readonly permissionKeys: readonly string[];
}

export type RoleCeilingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "role_assign_missing" }
  | { readonly ok: false; readonly reason: "reserved"; readonly roleKey: string }
  | {
      readonly ok: false;
      readonly reason: "escalation";
      readonly roleKey: string;
      readonly permission: string;
    };

/** Pure ceiling check: may an inviter holding `held` propose all of `roles`? */
export function checkRoleCeiling(
  held: ReadonlySet<string>,
  roles: readonly ProposableRole[],
): RoleCeilingVerdict {
  if (roles.length === 0) return { ok: true };
  if (!held.has(ROLE_ASSIGN_PERMISSION)) return { ok: false, reason: "role_assign_missing" };
  for (const role of roles) {
    if (isTenantRoleReserved(role)) return { ok: false, reason: "reserved", roleKey: role.key };
    const permission = role.permissionKeys.find((key) => !held.has(key));
    if (permission !== undefined)
      return { ok: false, reason: "escalation", roleKey: role.key, permission };
  }
  return { ok: true };
}

/** Resolves an org's ENABLED roles by key, with their permission keys (reserved rows included). */
export type OrgRoleLookup = (
  organizationId: string,
  roleKeys: readonly string[],
) => Promise<readonly ProposableRole[]>;

/** M02 provisioning port: turn tenant-scoped role ids into keys without allowing foreign ids. */
export interface ProvisioningRoleResolver {
  resolveKeys(organizationId: string, roleIds: readonly string[]): Promise<readonly string[]>;
}

export function createDbProvisioningRoleResolver(db: DbClient): ProvisioningRoleResolver {
  return {
    async resolveKeys(organizationId, roleIds) {
      const wanted = [...new Set(roleIds)];
      if (wanted.length === 0) return [];
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({ id: schema.roles.id, key: schema.roles.key })
          .from(schema.roles)
          .where(
            and(
              eq(schema.roles.organizationId, organizationId),
              inArray(schema.roles.id, wanted),
              eq(schema.roles.enabled, true),
            ),
          ),
      );
      // One generic result prevents a foreign role id from becoming a cross-tenant existence oracle.
      if (rows.length !== wanted.length)
        throw new ChartWardenError("INVALID_ROLE", "one or more roles are unavailable", 422);
      const byId = new Map(rows.map((row) => [row.id, row.key]));
      return wanted.map((id) => byId.get(id)!);
    },
  };
}

/** Org-scoped (RLS + explicit predicate) lookup over `role` + `role_permission`. */
export function createDbOrgRoleLookup(db: DbClient): OrgRoleLookup {
  return async (organizationId, roleKeys) => {
    const wanted = [...new Set(roleKeys)].filter((key) => key.length > 0);
    if (wanted.length === 0) return [];
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select({ id: schema.roles.id, key: schema.roles.key, category: schema.roles.category })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.organizationId, organizationId),
            inArray(schema.roles.key, wanted),
            eq(schema.roles.enabled, true),
          ),
        );
      if (rows.length === 0) return [];
      const perms = await tx
        .select({
          roleId: schema.rolePermissions.roleId,
          key: schema.rolePermissions.permissionKey,
        })
        .from(schema.rolePermissions)
        .where(
          inArray(
            schema.rolePermissions.roleId,
            rows.map((r) => r.id),
          ),
        );
      return rows.map((row) => ({
        ...row,
        permissionKeys: perms.filter((p) => p.roleId === row.id).map((p) => p.key),
      }));
    });
  };
}

const reservedRole = () =>
  new ChartWardenError(
    "RESERVED_ROLE",
    "platform role keys (platform_*, ai_safety_owner) and the platform_staff category are reserved to the platform",
    422,
  );

/** M2's invite-create port (structural twin of `ProposedRoleGuard` in 02-identity/identity-ports). */
export interface ProposedRoleGuard {
  assertProposable(input: {
    readonly organizationId: string;
    readonly inviterUserId: string;
    readonly roleKeys: readonly string[];
    readonly auditContext: AuditContext;
  }): Promise<void>;
}

/**
 * Invite-creation guard. Keys the org has no role for are not an escalation (they confer nothing, and
 * the attach step re-checks whatever exists by then); everything that does resolve must pass
 * {@link checkRoleCeiling}. Refusals are 403 `ESCALATION_BLOCKED` (audited) or 422 `RESERVED_ROLE`.
 */
export function createProposedRoleGuard(deps: {
  readonly lookup: OrgRoleLookup;
  readonly effectivePermissions: ActorPermissionResolver;
  readonly audit: AuditExecutor;
}): ProposedRoleGuard {
  return {
    async assertProposable({ organizationId, inviterUserId, roleKeys, auditContext }) {
      if (roleKeys.length === 0) return;
      // By KEY first: platform roles are `organization_id IS NULL`, so the org lookup below never finds
      // them, and "no such org role" must not read as "safe to store a platform-role proposal".
      if (roleKeys.some((key) => isReservedPlatformRoleKey(key))) throw reservedRole();
      const roles = await deps.lookup(organizationId, roleKeys);
      const held = await deps.effectivePermissions({ organizationId, userId: inviterUserId });
      const verdict = checkRoleCeiling(held, roles);
      if (verdict.ok) return;
      if (verdict.reason === "reserved") throw reservedRole();
      const attemptedPermission =
        verdict.reason === "escalation" ? verdict.permission : ROLE_ASSIGN_PERMISSION;
      await auditEscalationBlocked(deps.audit, auditContext, { attemptedPermission });
      throw new ChartWardenError(
        "ESCALATION_BLOCKED",
        verdict.reason === "escalation"
          ? `cannot propose role '${verdict.roleKey}': it grants '${verdict.permission}', which you do not hold`
          : `proposing roles requires the '${ROLE_ASSIGN_PERMISSION}' permission`,
        FORBIDDEN_STATUS,
      );
    },
  };
}
