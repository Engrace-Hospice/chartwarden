// apps/backend/src/bootstrap/bind-compliance-officer-role.ts — the platform half of designating a new tenant's compliance
// officer: grant the `compliance_officer` role to one ACTIVE member of the tenant, on the TENANT pool under the tenant's own
// RLS scope, with an audit event in the same transaction.
//
// WHY THE PLATFORM DOES IT. The tenant's org_admin cannot: M3's anti-escalation refuses a grant of a permission the grantor
// does not hold, and `compliance_officer` carries keys `org_admin` deliberately lacks (messaging.redact.request/approve,
// ADR-0055 D9; the full-catalog roles exclude them on purpose, template-materialization.ts). Widening `org_admin` would erase
// that separation, so the one place the role is bound for a brand-new tenant is the PLATFORM compliance-officer assignment
// route, which already requires a fresh step-up, a written reason and `platform_ops`, and calls this only while the tenant is
// onboarding (wizard-service.ts decides that; this file does not re-decide it, it only refuses what it can see is unsafe).
//
// SCOPE OF THE GRANT. Exactly one role, by a constant key, never one the caller names; to an ACTIVE membership of THIS
// organisation; no scope narrowing and no expiry (the officer is a standing role). It does not touch the tenant's other grants.
// The write runs as the NOBYPASSRLS tenant role, so it cannot reach another organisation even if a wrong id were passed.
// Audited like any M3 role assignment (`m3.role.assigned`) plus who really did it: the operator, the reason and the tenant.
//
// NEVER ChartWarden STAFF. The wizard service already refuses to name platform staff the officer; this refuses again at the
// grant itself (a second caller must not be able to give the role to an operator): the member's user may not be the operator,
// hold the platform alert-audience binding in this organisation, or hold a live platform role at home. 422 COMPLIANCE_OFFICER_PLATFORM_STAFF.
import { randomUUID } from "node:crypto";
import { audit } from "@chartwarden/audit";
import { PLATFORM_ALERT_AUDIENCE_ROLE_KEY, PLATFORM_GRANTABLE_ROLE_KEYS } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";

export const COMPLIANCE_OFFICER_ROLE_KEY = "compliance_officer";

export interface ComplianceOfficerRoleBindInput {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly membershipId: string;
  readonly operator: { readonly userId: string; readonly membershipId: string };
  readonly reason: string;
}

/**
 * Build the binder. `onBound` runs AFTER the grant commits, with the member's user id, so the composition root can drop that
 * user's cached permissions (M3 caches an actor's set for minutes: without this the new officer could not attest at once).
 */
export function createComplianceOfficerRoleBinder(
  db: DbClient,
  onBound?: (organizationId: string, userId: string) => void,
): (input: ComplianceOfficerRoleBindInput) => Promise<void> {
  return async (input) => {
    const memberUserId = await withOrgContext(
      db,
      { organizationId: input.organizationId, userId: input.operator.userId },
      async (rawTx) => {
        const tx = rawTx as unknown as DbClient;
        // This organisation's own role row: RLS also admits org-NULL platform template rows (migration 0025), so the explicit
        // organization predicate is what keeps "this org's role" meaning what it says.
        const [role] = await tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(
            and(
              eq(schema.roles.organizationId, input.organizationId),
              eq(schema.roles.key, COMPLIANCE_OFFICER_ROLE_KEY),
              eq(schema.roles.enabled, true),
            ),
          )
          .limit(1);
        if (!role) {
          throw new ChartWardenError(
            "COMPLIANCE_OFFICER_ROLE_UNAVAILABLE",
            "this organization has no enabled compliance_officer role",
            422,
          );
        }
        const [member] = await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.id, input.membershipId),
              eq(schema.memberships.organizationId, input.organizationId),
              eq(schema.memberships.status, "active"),
            ),
          )
          .limit(1);
        if (!member) {
          throw new ChartWardenError(
            "COMPLIANCE_OFFICER_NOT_A_MEMBER",
            "the compliance officer must be an active member of this organization",
            422,
          );
        }
        if (await isPlatformStaffUser(tx, input, member.userId)) {
          throw new ChartWardenError(
            "COMPLIANCE_OFFICER_PLATFORM_STAFF",
            "ChartWarden platform staff cannot be the compliance officer: the officer must be a member of the customer's own staff",
            422,
          );
        }
        // Idempotent on (membership, role): a replay, or a grant that had expired, ends as one standing grant.
        await tx
          .insert(schema.membershipRoles)
          .values({
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            roleId: role.id,
            scope: {},
            grantedBy: input.operator.userId,
            expiresAt: null,
          })
          .onConflictDoUpdate({
            target: [schema.membershipRoles.membershipId, schema.membershipRoles.roleId],
            set: { expiresAt: null },
          });
        await audit(
          tx,
          {
            organizationId: input.organizationId,
            userId: input.operator.userId,
            actorKind: "user",
            correlationId: `m34-onboarding:compliance_officer_role_bound:${input.tenantAccountId}:${randomUUID()}`,
          },
          {
            eventType: "m3.role.assigned",
            resourceKind: "membership_role",
            resourceId: input.membershipId,
            outcome: "success",
            severity: "warn",
            retentionClass: "compliance",
            after: {
              roleKey: COMPLIANCE_OFFICER_ROLE_KEY,
              scope: {},
              expiresAt: null,
              assignedBy: "platform_ops",
              operatorUserId: input.operator.userId,
              operatorMembershipId: input.operator.membershipId,
              tenantAccountId: input.tenantAccountId,
              reason: input.reason,
            },
          },
        );
        return member.userId;
      },
    );
    onBound?.(input.organizationId, memberUserId);
  };
}

/** The operator themselves, a member bound to the platform alert-audience role here, or a live platform role holder at home. */
async function isPlatformStaffUser(
  tx: DbClient,
  input: ComplianceOfficerRoleBindInput,
  memberUserId: string,
): Promise<boolean> {
  if (memberUserId === input.operator.userId) return true;
  const audience = await tx
    .select({ id: schema.membershipRoles.id })
    .from(schema.membershipRoles)
    .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
    .where(
      and(
        eq(schema.membershipRoles.membershipId, input.membershipId),
        eq(schema.membershipRoles.organizationId, input.organizationId),
        eq(schema.roles.key, PLATFORM_ALERT_AUDIENCE_ROLE_KEY),
      ),
    )
    .limit(1);
  if (audience.length > 0) return true;
  const holders = await tx.execute<{ user_id: string }>(
    sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${sql.join(
      PLATFORM_GRANTABLE_ROLE_KEYS.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) WHERE user_id = ${memberUserId}::uuid`,
  );
  return holders.rows.length > 0;
}
