// apps/backend/src/modules/03-authorization — the PRODUCTION MembershipRoleStore (M3 §2.2, §7.2).
//
// Assign / list / revoke role grants on a membership (the M2↔M3 handshake row), over the M3-owned
// `membership_role` table joined to `role` for the key. Runs inside withOrgContext so RLS scopes by
// app.org_id. `assign` carries the org in its input; `listForMembership` / `revoke` take only a
// membership id, so they resolve the org from the AMBIENT request context (withOrgContextFromRequest) —
// the route is already org-scoped, and a bare `WHERE membership_id=…` would return nothing under the
// real wardenx_app role.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { M3OutboxPublisher, MembershipRoleStore, MembershipRoleView } from "./authz-ports";

const GRANT_COLUMNS = {
  grantId: schema.membershipRoles.id,
  membershipId: schema.membershipRoles.membershipId,
  roleId: schema.membershipRoles.roleId,
  roleKey: schema.roles.key,
  scope: schema.membershipRoles.scope,
  expiresAt: schema.membershipRoles.expiresAt,
} as const;

function toView(row: {
  grantId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  scope: unknown;
  expiresAt: Date | null;
}): MembershipRoleView {
  return {
    grantId: row.grantId,
    membershipId: row.membershipId,
    roleId: row.roleId,
    roleKey: row.roleKey,
    scope: row.scope,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/** Build the live MembershipRoleStore over the pooled Drizzle client. */
export function createDbMembershipRoleStore(
  db: DbClient,
  outbox?: M3OutboxPublisher,
): MembershipRoleStore {
  return {
    async listForMembership(membershipId: string): Promise<MembershipRoleView[]> {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select(GRANT_COLUMNS)
          .from(schema.membershipRoles)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
          .where(eq(schema.membershipRoles.membershipId, membershipId));
        return rows.map(toView);
      });
    },

    async assign(input): Promise<MembershipRoleView> {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.grantedByUserId },
        async (tx) => {
          const inserted = (await tx
            .insert(schema.membershipRoles)
            .values({
              organizationId: input.organizationId,
              membershipId: input.membershipId,
              roleId: input.roleId,
              scope: (input.scope ?? {}) as Record<string, unknown>,
              grantedBy: input.grantedByUserId,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            })
            .returning({
              grantId: schema.membershipRoles.id,
              scope: schema.membershipRoles.scope,
              expiresAt: schema.membershipRoles.expiresAt,
            })) as Array<{ grantId: string; scope: unknown; expiresAt: Date | null }>;
          const row = inserted[0]!;
          await outbox?.publish(tx as never, {
            eventName: "m3.role.assigned",
            payload: {
              organizationId: input.organizationId,
              membershipId: input.membershipId,
              roleId: input.roleId,
              roleKey: input.roleKey,
              grantedByUserId: input.grantedByUserId,
            },
            organizationId: input.organizationId,
            aggregateKind: "membership_role",
            aggregateId: row.grantId,
          });
          return toView({
            grantId: row.grantId,
            membershipId: input.membershipId,
            roleId: input.roleId,
            roleKey: input.roleKey,
            scope: row.scope,
            expiresAt: row.expiresAt,
          });
        },
      );
    },

    async revoke(membershipId: string, roleId: string): Promise<boolean> {
      return withOrgContextFromRequest(db, async (tx) => {
        const deleted = (await tx
          .delete(schema.membershipRoles)
          .where(
            and(
              eq(schema.membershipRoles.membershipId, membershipId),
              eq(schema.membershipRoles.roleId, roleId),
            ),
          )
          .returning({
            id: schema.membershipRoles.id,
            organizationId: schema.membershipRoles.organizationId,
          })) as Array<{ id: string; organizationId: string }>;
        for (const grant of deleted) {
          await outbox?.publish(tx as never, {
            eventName: "m3.role.revoked",
            payload: { organizationId: grant.organizationId, membershipId, roleId },
            organizationId: grant.organizationId,
            aggregateKind: "membership_role",
            aggregateId: grant.id,
          });
        }
        return deleted.length > 0;
      });
    },
  };
}
