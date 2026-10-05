// apps/backend/src/modules/03-authorization/proposed-role-attacher.ts — the M2→M3 handshake M2's spec
// calls Decided and nothing implemented (F-097).
//
// M2 §D3: "Membership→role assignment is Module 3. M2 carries `proposedRoleKeys` … and creates the
// membership; M3 attaches roles on accept." M2 §11 "Done means" says the same: "lands in the org as an
// `active` membership … Roles attach via Module 3 from `proposedRoleKeys`."
//
// It never happened. `POST /api/v1/invitations/accept` consumed the invitation, created the membership,
// and returned — carrying a comment ("proposedRoleKeys are carried to M3 on accept (role attach is
// M3-owned, §7.1)") that named the mechanism as someone else's while nobody had it. There is no event
// path either: M2 contributes NO outbox catalog at all (no `events-by-m2.ts`, no `M2_OUTBOX_EVENTS` —
// the same absence #205 recorded as the blocker for M35's four `m2.*` subscriptions), so
// `m2.membership.accepted` exists only as an AUDIT action and nothing can subscribe to it.
//
// The cost is quiet and total: an admin invites an RN with `proposedRoleKeys: ["clinical_rn"]`, the RN
// accepts, the RN holds ZERO grants — no error, no warning, and the `organization_invitation` row still
// shows the roles that were requested, so the admin surface reports access the user does not have. The
// only recovery is an admin noticing and re-granting by hand through M3's own route.
//
// WHY A NARROW PORT RATHER THAN `MembershipRoleStore.assign`. `assign` takes a resolved `roleId` and
// grants exactly one role, so a caller with KEYS would have to resolve each one itself, decide what an
// unknown key means, and run N transactions with no atomicity across them. Accept is a one-shot,
// idempotent, at-least-once path (the invitation consume already races), so the resolution and the
// grants belong in ONE transaction that can be replayed.
import { isTenantRoleReserved } from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import type { ActorPermissionResolver, M3OutboxPublisher } from "./authz-ports";
import { ROLE_ASSIGN_PERMISSION, createDbOrgRoleLookup } from "./proposed-role-ceiling";

/** What attaching an invitation's proposed roles did. */
export interface ProposedRoleAttachResult {
  /** Role keys that resolved to a role in this org and now have a grant on the membership. */
  readonly attached: readonly string[];
  /**
   * Role keys the invitation named that this org has NO role row for.
   *
   * Reported, never swallowed. This is the state a freshly provisioned tenant is in for every key: the
   * M34 provisioning worker seeds a key ring, storage prefixes, an organization, onboarding tasks and
   * the first-admin invitation, and NO `role` rows — `ROLE_TEMPLATES` has no materializer anywhere (the
   * `permission` catalog has `db:sync:permissions`; roles have no sibling), so outside the dev seed
   * scripts the table starts empty. Returning silence here would reproduce the defect this file fixes
   * one layer down.
   */
  readonly unresolved: readonly string[];
}

/** Attach an accepted invitation's `proposedRoleKeys` to the new membership (M2 §D3). */
export interface ProposedRoleAttacher {
  attach(input: {
    organizationId: string;
    membershipId: string;
    roleKeys: readonly string[];
    /**
     * The INVITER (GAP-008). The ceiling is theirs: a role is attached only if every permission it grants
     * is one this user holds now, and they still hold `role.assign`. `null` (a legacy invitation row, or
     * an inviter since deleted) has no ceiling to compute, so nothing is attached.
     */
    grantedByUserId: string | null;
  }): Promise<ProposedRoleAttachResult>;
}

/**
 * The production attacher: resolve the keys to this org's roles and grant them, in one RLS-scoped
 * transaction.
 *
 * IDEMPOTENT BY CONSTRAINT, not by pre-read. `membership_role_idx` is UNIQUE on
 * (membership_id, role_id), so `onConflictDoNothing` makes a replayed accept a no-op rather than a
 * duplicate-key 500. A read-then-insert would let two concurrent replays both pass the check — the same
 * race M2's own invitation `consume` solves by putting the status predicate inside the UPDATE.
 *
 * The role lookup is org-scoped by RLS AND by an explicit `organization_id` predicate. Migration 0025
 * widened the role read policy to admit org-NULL platform template rows, so RLS alone would let a
 * template row resolve here and be granted into a tenant that never created it — the predicate is what
 * keeps "this org's roles" meaning what it says.
 */
export function createDbProposedRoleAttacher(
  db: DbClient,
  /** Required, not optional: an attacher without the inviter's ceiling is the GAP-008 defect. */
  effectivePermissions: ActorPermissionResolver,
  /** GAP-010 — `m3.role.assigned` per newly attached role, on the attach's own tx. Omitted → dropped. */
  outbox?: M3OutboxPublisher,
): ProposedRoleAttacher {
  const lookup = createDbOrgRoleLookup(db);
  return {
    async attach({ organizationId, membershipId, roleKeys, grantedByUserId }) {
      const wanted = [...new Set(roleKeys)].filter((key) => key.length > 0);
      if (wanted.length === 0) return { attached: [], unresolved: [] };

      // GAP-008 — the inviter's CURRENT ceiling, re-evaluated at accept: their permissions, or the
      // role's, may have changed in the days between invite and accept. A key above the ceiling is
      // reported `unresolved` (requested, not granted) exactly like a key the org has no role for.
      // Fail closed: no inviter, or an inviter without `role.assign`, grants nothing.
      const grantable = await resolveGrantable({
        organizationId,
        grantedByUserId,
        wanted,
        lookup,
        effectivePermissions,
      });

      return withOrgContext(db, { organizationId, userId: grantedByUserId ?? "" }, async (tx) => {
        const candidates = await tx
          .select({ id: schema.roles.id, key: schema.roles.key, category: schema.roles.category })
          .from(schema.roles)
          .where(
            and(
              eq(schema.roles.organizationId, organizationId),
              inArray(schema.roles.key, wanted),
              eq(schema.roles.enabled, true),
            ),
          );
        // GAP-003/GAP-096: a tenant-owned row carrying a reserved platform key/category confers nothing
        // and the M3 assign route refuses it (422 RESERVED_ROLE); accept must not be a way around that.
        // It is reported `unresolved`, like a key the org has no role for.
        const rows = candidates.filter(
          (row) => !isTenantRoleReserved(row) && grantable.has(row.id),
        );
        const byKey = new Map(rows.map((row) => [row.key, row.id]));
        if (rows.length > 0) {
          const inserted = await tx
            .insert(schema.membershipRoles)
            .values(
              rows.map((row) => ({
                organizationId,
                membershipId,
                roleId: row.id,
                scope: {} as Record<string, unknown>,
                grantedBy: grantedByUserId,
                expiresAt: null,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: schema.membershipRoles.id, roleId: schema.membershipRoles.roleId });
          // Only NEWLY inserted grants announce themselves: a replayed accept conflicts, returns no row and
          // so publishes nothing (idempotent by the same constraint as the insert).
          const keyByRoleId = new Map(rows.map((row) => [row.id, row.key]));
          for (const grant of inserted) {
            await outbox?.publish(tx as never, {
              eventName: "m3.role.assigned",
              payload: {
                organizationId,
                membershipId,
                roleId: grant.roleId,
                roleKey: keyByRoleId.get(grant.roleId) ?? "",
                grantedByUserId,
              },
              organizationId,
              aggregateKind: "membership_role",
              aggregateId: grant.id,
            });
          }
        }
        return {
          attached: wanted.filter((key) => byKey.has(key)),
          unresolved: wanted.filter((key) => !byKey.has(key)),
        };
      });
    },
  };
}

/** Role ids (of `wanted`) whose every permission the inviter holds, and only if they hold `role.assign`. */
async function resolveGrantable(input: {
  organizationId: string;
  grantedByUserId: string | null;
  wanted: readonly string[];
  lookup: ReturnType<typeof createDbOrgRoleLookup>;
  effectivePermissions: ActorPermissionResolver;
}): Promise<ReadonlySet<string>> {
  if (input.grantedByUserId === null) return new Set();
  const held = await input.effectivePermissions({
    organizationId: input.organizationId,
    userId: input.grantedByUserId,
  });
  if (!held.has(ROLE_ASSIGN_PERMISSION)) return new Set();
  const roles = await input.lookup(input.organizationId, input.wanted);
  return new Set(
    roles.filter((role) => role.permissionKeys.every((key) => held.has(key))).map((r) => r.id),
  );
}
