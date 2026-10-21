import type { RoleCategory } from "@chartwarden/auth";
// WP 2.7b C3 (ADR-0058 "Who may call the route: role categories") - the workforce-category gate of the global search route.
//
// The route needs `messaging.read` AND an active role in the allow-list below AND no active role in the excluded set (deny
// wins). It exists because nothing structurally stops a tenant granting `messaging.read` to a role of an excluded category.
//   * allow: clinical_staff, clinical_leadership, operations, admin_executive, billing_finance, compliance_quality
//   * deny:  patient_family, external_auditor, platform_staff (never workforce members with a messaging surface)
//   * off:   external_collaborator, volunteer, temporary_special (off by default; reviewers may add them)
// The policy is a `Record<RoleCategory, ...>`, so a category added to `RoleCategory` fails compilation until it is classified.
// An excluded role counts even when `role.enabled = false` (a disabled role is still the identity's role); the allow side
// requires an enabled role. A role the TypeScript map does not know (a new DB enum value) is treated as deny: fail closed.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull, or, sql } from "drizzle-orm";

export type RoleCategoryPolicy = "allow" | "deny" | "off";

export const GLOBAL_SEARCH_ROLE_POLICY: Readonly<Record<RoleCategory, RoleCategoryPolicy>> = {
  clinical_staff: "allow",
  clinical_leadership: "allow",
  operations: "allow",
  admin_executive: "allow",
  billing_finance: "allow",
  compliance_quality: "allow",
  patient_family: "deny",
  external_auditor: "deny",
  platform_staff: "deny",
  external_collaborator: "off",
  volunteer: "off",
  temporary_special: "off",
};

export interface HeldRole {
  readonly category: string;
  readonly enabled: boolean;
}

function policyOf(category: string): RoleCategoryPolicy {
  return Object.hasOwn(GLOBAL_SEARCH_ROLE_POLICY, category)
    ? GLOBAL_SEARCH_ROLE_POLICY[category as RoleCategory]
    : "deny";
}

/** Pure decision over the caller's active roles. */
export function mayUseGlobalSearch(roles: readonly HeldRole[]): boolean {
  let allowed = false;
  for (const role of roles) {
    const policy = policyOf(role.category);
    if (policy === "deny") return false;
    if (policy === "allow" && role.enabled) allowed = true;
  }
  return allowed;
}

export interface RoleGate {
  mayUse(organizationId: string, userId: string): Promise<boolean>;
}

/** The caller's active roles: active membership, grant not expired, in this organisation. */
export function createRoleGate(db: DbClient): RoleGate {
  const MEMBERSHIP = schema.memberships;
  const MEMBERSHIP_ROLE = schema.membershipRoles;
  const ROLE = schema.roles;
  return {
    async mayUse(organizationId, userId) {
      const roles = await withOrgContext(db, { organizationId, userId }, (tx) =>
        tx
          .select({ category: ROLE.category, enabled: ROLE.enabled })
          .from(MEMBERSHIP)
          .innerJoin(
            MEMBERSHIP_ROLE,
            and(
              eq(MEMBERSHIP_ROLE.membershipId, MEMBERSHIP.id),
              eq(MEMBERSHIP_ROLE.organizationId, MEMBERSHIP.organizationId),
            ),
          )
          .innerJoin(ROLE, eq(ROLE.id, MEMBERSHIP_ROLE.roleId))
          .where(
            and(
              eq(MEMBERSHIP.organizationId, organizationId),
              eq(MEMBERSHIP.userId, userId),
              eq(MEMBERSHIP.status, "active"),
              or(isNull(MEMBERSHIP_ROLE.expiresAt), sql`${MEMBERSHIP_ROLE.expiresAt} > now()`),
            ),
          ),
      );
      return mayUseGlobalSearch(roles);
    },
  };
}
