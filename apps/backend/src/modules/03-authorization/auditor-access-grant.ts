// apps/backend/src/modules/03-authorization/auditor-access-grant.ts — M3's half of auditor magic-link
// redemption (M2 `auditor-redemption.ts`). M2 owns the session and the membership; M3 owns the roles, the
// grants and the engagement, so the least-privilege grant is M3's, called by M2 INSIDE its redemption
// transaction through a structural port (no M2→M3 import edge — wired at the composition root).
//
// LEAST PRIVILEGE. An auditor holds exactly ONE role, `external_auditor`, holding exactly the permissions in
// {@link EXTERNAL_AUDITOR_PERMISSIONS} (today: the engagement-scoped read, `portal.engagement.read_auditor`).
// The role is created on first redemption in the org (nothing materializes ROLE_TEMPLATES — the same fact
// `proposed-role-attacher.ts` records). The grant carries `expires_at = engagement end`, so the RBAC engine
// stops honouring it with the window even if the session were somehow still alive.
//
// FAIL CLOSED, three ways, before anything is granted:
//   • the engagement must be live NOW (org, `active`, inside its window) — a cancelled engagement whose
//     links the close cron has not yet revoked still cannot be redeemed;
//   • an identity that already holds any OTHER role in the org is refused: an `auditor`-class session
//     resolves its permissions from the membership, so reusing a staff membership would hand the auditor the
//     staff member's access;
//   • if the org's `external_auditor` role has been widened beyond the auditor minimum, redemption is refused
//     (an administrator must correct it) rather than silently trimmed or silently honoured.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { isEngagementLive } from "./engagement-scope";

export const EXTERNAL_AUDITOR_ROLE_KEY = "external_auditor";
/** The auditor minimum. `portal.engagement.read_auditor` is the engagement-scoped, read-only view (M31). */
export const EXTERNAL_AUDITOR_PERMISSIONS = ["portal.engagement.read_auditor"] as const;

/** Refusals this port can return (a subset of M2's `AuditorRefusalReason`, kept structurally compatible). */
export type AuditorAccessRefusal =
  | "engagement_not_active"
  | "identity_is_member"
  | "role_over_privileged";

export interface AuditorAccessGrantor {
  check(
    tx: DbClient,
    input: {
      organizationId: string;
      engagementId: string;
      membershipId: string | null;
      at: Date;
    },
  ): Promise<AuditorAccessRefusal | null>;
  grant(
    tx: DbClient,
    input: {
      organizationId: string;
      engagementId: string;
      membershipId: string;
      userId: string;
      expiresAt: Date;
    },
  ): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDbAuditorAccessGrantor(): AuditorAccessGrantor {
  /** This org's `external_auditor` role id, with the permission keys it currently holds; null when absent. */
  async function findRole(tx: DbClient, organizationId: string) {
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.organizationId, organizationId),
          eq(schema.roles.key, EXTERNAL_AUDITOR_ROLE_KEY),
        ),
      )
      .limit(1);
    if (!role) return null;
    const perms = await tx
      .select({ key: schema.rolePermissions.permissionKey })
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.roleId, role.id));
    return { id: role.id, permissions: perms.map((p) => p.key) };
  }

  const isMinimum = (permissions: readonly string[]): boolean =>
    permissions.every((p) => (EXTERNAL_AUDITOR_PERMISSIONS as readonly string[]).includes(p));

  return {
    async check(tx, input) {
      if (!UUID_RE.test(input.engagementId)) return "engagement_not_active";
      const [engagement] = await tx
        .select({
          organizationId: schema.auditorEngagements.organizationId,
          status: schema.auditorEngagements.status,
          startAt: schema.auditorEngagements.startAt,
          endAt: schema.auditorEngagements.endAt,
        })
        .from(schema.auditorEngagements)
        .where(
          and(
            eq(schema.auditorEngagements.id, input.engagementId),
            eq(schema.auditorEngagements.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      if (!engagement || !isEngagementLive(engagement, input.organizationId, input.at)) {
        return "engagement_not_active";
      }

      if (input.membershipId) {
        const [other] = await tx
          .select({ roleId: schema.membershipRoles.roleId })
          .from(schema.membershipRoles)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
          .where(
            and(
              eq(schema.membershipRoles.membershipId, input.membershipId),
              ne(schema.roles.key, EXTERNAL_AUDITOR_ROLE_KEY),
            ),
          )
          .limit(1);
        if (other) return "identity_is_member";
      }

      const role = await findRole(tx, input.organizationId);
      if (role && !isMinimum(role.permissions)) return "role_over_privileged";
      return null;
    },

    async grant(tx, input) {
      let role = await findRole(tx, input.organizationId);
      if (!role) {
        await tx
          .insert(schema.roles)
          .values({
            organizationId: input.organizationId,
            key: EXTERNAL_AUDITOR_ROLE_KEY,
            name: "External Auditor",
            category: "external_auditor",
            scopeLevel: "organization",
            systemDefault: true,
            systemLocked: false,
            enabled: true,
            description:
              "Time-boxed, read-only engagement auditor. Granted by auditor link redemption; holds only the auditor minimum.",
          })
          .onConflictDoNothing();
        role = await findRole(tx, input.organizationId);
      }
      if (!role) throw new Error("external_auditor role could not be resolved");
      if (!isMinimum(role.permissions)) {
        throw new Error("external_auditor role holds more than the auditor minimum");
      }
      for (const permissionKey of EXTERNAL_AUDITOR_PERMISSIONS) {
        await tx
          .insert(schema.rolePermissions)
          .values({ organizationId: input.organizationId, roleId: role.id, permissionKey })
          .onConflictDoNothing();
      }
      // One grant per (membership, role): a second engagement for the same auditor extends the expiry to
      // the later window end, never shortens a still-live one.
      await tx
        .insert(schema.membershipRoles)
        .values({
          organizationId: input.organizationId,
          membershipId: input.membershipId,
          roleId: role.id,
          scope: { engagementId: input.engagementId },
          grantedBy: null,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: [schema.membershipRoles.membershipId, schema.membershipRoles.roleId],
          set: {
            scope: { engagementId: input.engagementId },
            expiresAt: sql`GREATEST(${schema.membershipRoles.expiresAt}, EXCLUDED.expires_at)`,
          },
        });
    },
  };
}
