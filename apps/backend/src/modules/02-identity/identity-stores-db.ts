import { createHash, randomUUID } from "node:crypto";
// apps/backend/src/modules/02-identity — DB-backed InvitationStore + UserDirectory.
//
// Replaces two of the four in-memory slices `mountIdentityRoutes` was still wiring in PRODUCTION.
// Both were process-local `Map`s, so on the production mount they meant:
//   * an invitation minted on replica A did not exist on replica B, and every pending invitation
//     evaporated on deploy — while `pendingExists` kept reporting "no pending invite", so the
//     duplicate-invite guard (§7.11) was not a guard at all;
//   * `deactivate` (the §7.5 full-offboard credential kill) wrote to a Map and returned success. An
//     offboarded user's credentials were never actually disabled anywhere.
//
// Drizzle QUERY BUILDER only, never raw SQL — `scripts/check-table-ownership.ts` flags raw SQL that
// touches another module's table, and this file reads the M1-owned `organization` and `users`
// (mirrors membership-repository.ts / session-writer-db.ts).
//
// TOKEN HANDLING. `organization_invitation.token_hash` stores a SHA-256 of the opaque token; the raw
// token is never PERSISTED anywhere. It DOES leave the store on `create`/`resend` (TASK-030) — the
// route is the only caller, and uses it exactly once, to build the accept link for the email transport
// and (since no vendor sender is wired yet) to echo an admin-visible copyable link back to the inviter.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import {
  type InvitationDetail,
  type InvitationListItem,
  type InvitationStore,
  LinkError,
  type MembershipStanding,
  type MembershipStatus,
  type MintedInvitation,
  type RevokedMembership,
  type UserDirectory,
  decideOrgBoundedDeactivation,
  liveMembershipOrganizationIds,
} from "./identity-ports";

/** 72h invite TTL — the same window the in-memory slice used (§7.11). */
const INVITE_TTL_MS = 72 * 3600 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * DB-backed invitations over the M2-owned `organization_invitation`.
 *
 * `pendingExists` / `pendingCount` narrow on `status = 'pending'`; expiry is enforced at consume time
 * rather than by a status sweep, so a lapsed row still reads as pending until someone tries it (the
 * table has no expiry job, and reporting an expired invite as "not pending" would silently re-open the
 * duplicate-invite window this guard exists to close).
 */
export function createDbInvitationStore(db: DbClient): InvitationStore {
  const I = schema.organizationInvitations;
  // Invitation rows are org-scoped. The store is invoked by authenticated org routes, but it
  // previously issued bare queries and therefore never set app.org_id for the RLS policy.
  const inOrganization = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext<DbClient, T>(db, { organizationId, userId: "" }, fn);

  return {
    async pendingExists(organizationId, email) {
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select({ id: I.id })
          .from(I)
          .where(
            and(eq(I.organizationId, organizationId), eq(I.email, email), eq(I.status, "pending")),
          )
          .limit(1);
        return rows.length > 0;
      });
    },

    async pendingCount(organizationId) {
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select({ n: count() })
          .from(I)
          .where(and(eq(I.organizationId, organizationId), eq(I.status, "pending")));
        return Number(rows[0]?.n ?? 0);
      });
    },

    async list(organizationId) {
      return inOrganization(organizationId, async (tx) => {
        const rows = await tx
          .select({
            id: I.id,
            email: I.email,
            status: I.status,
            expiresAt: I.expiresAt,
            createdAt: I.createdAt,
          })
          .from(I)
          .where(eq(I.organizationId, organizationId))
          .orderBy(desc(I.createdAt));
        return rows.map(
          (r): InvitationListItem => ({
            invitationId: r.id,
            email: r.email,
            // `accepted`/`revoked`/`pending` are the only statuses the roster ever surfaces (the
            // invitationStatus enum has no other member, per packages/db/src/enums.ts).
            status: r.status as InvitationListItem["status"],
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
          }),
        );
      });
    },

    async create(input) {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      return inOrganization(input.organizationId, async (tx) => {
        const rows = await tx
          .insert(I)
          .values({
            organizationId: input.organizationId,
            email: input.email,
            status: "pending",
            tokenHash: hashToken(token),
            proposedRoleKeys: input.proposedRoleKeys,
            proposedDefaultLocationIds: input.defaultLocationIds,
            ...(input.proposedProviderEntityId
              ? { proposedDefaultProviderEntityId: input.proposedProviderEntityId }
              : {}),
            expiresAt,
          })
          .returning({ id: I.id, expiresAt: I.expiresAt });
        const row = rows[0];
        if (!row) throw new Error("invitation insert returned no row");
        return { invitationId: row.id, token, expiresAt: row.expiresAt.toISOString() };
      });
    },

    async resend(invitationId): Promise<MintedInvitation | null> {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      // The status predicate is part of the UPDATE (same atomic-guard pattern as `consume`/`rescind`):
      // re-minting a no-longer-pending invite (already accepted/revoked) is refused, not resurrected.
      return withOrgContextFromRequest<DbClient, MintedInvitation | null>(db, async (tx) => {
        const rows = await tx
          .update(I)
          .set({ tokenHash: hashToken(token), expiresAt })
          .where(and(eq(I.id, invitationId), eq(I.status, "pending")))
          .returning({ id: I.id, expiresAt: I.expiresAt });
        const row = rows[0];
        if (!row) return null;
        return { invitationId: row.id, token, expiresAt: row.expiresAt.toISOString() };
      });
    },

    async peek(token) {
      const O = schema.organizations;
      const rows = await db
        .select({
          organizationId: I.organizationId,
          organizationName: O.displayName,
          email: I.email,
          status: I.status,
          proposedRoleKeys: I.proposedRoleKeys,
          proposedDefaultLocationIds: I.proposedDefaultLocationIds,
          expiresAt: I.expiresAt,
        })
        .from(I)
        .innerJoin(O, eq(O.id, I.organizationId))
        .where(eq(I.tokenHash, hashToken(token)))
        .limit(1);
      const row = rows[0];
      // Same unknown/expired collapse as `consume` — see its comment (no oracle for token existence).
      if (!row) throw new LinkError("expired", "invitation token invalid or expired");
      if (row.status === "accepted") throw new LinkError("used", "invitation already accepted");
      if (row.status !== "pending") throw new LinkError("expired", "invitation is no longer valid");
      if (row.expiresAt.getTime() <= Date.now())
        throw new LinkError("expired", "invitation expired");
      return {
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        email: row.email,
        proposedRoleKeys: (row.proposedRoleKeys ?? []) as readonly string[],
        defaultLocationIds: (row.proposedDefaultLocationIds ?? []) as readonly string[],
      } satisfies InvitationDetail;
    },

    async consume(token) {
      const O = schema.organizations;
      const rows = await db
        .select({
          id: I.id,
          organizationId: I.organizationId,
          organizationName: O.displayName,
          email: I.email,
          status: I.status,
          proposedRoleKeys: I.proposedRoleKeys,
          proposedDefaultLocationIds: I.proposedDefaultLocationIds,
          expiresAt: I.expiresAt,
        })
        .from(I)
        .innerJoin(O, eq(O.id, I.organizationId))
        .where(eq(I.tokenHash, hashToken(token)))
        .limit(1);
      const row = rows[0];
      // An unknown token and an expired one report the SAME thing on purpose: a distinct "no such
      // invitation" would turn this endpoint into an oracle for which tokens ever existed.
      if (!row) throw new LinkError("expired", "invitation token invalid or expired");
      if (row.status === "accepted") throw new LinkError("used", "invitation already accepted");
      if (row.status !== "pending") throw new LinkError("expired", "invitation is no longer valid");
      if (row.expiresAt.getTime() <= Date.now())
        throw new LinkError("expired", "invitation expired");

      // ATOMIC ONE-TIME CONSUMPTION (§7.12). The status predicate is part of the UPDATE, so two
      // concurrent accepts race in the database and exactly one updates a row — a read-then-write
      // would let both pass the check above and both accept. The loser is told "already accepted".
      const claimed = await db
        .update(I)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(and(eq(I.id, row.id), eq(I.status, "pending")))
        .returning({ id: I.id });
      if (claimed.length === 0) throw new LinkError("used", "invitation already accepted");

      return {
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        email: row.email,
        proposedRoleKeys: (row.proposedRoleKeys ?? []) as readonly string[],
        defaultLocationIds: (row.proposedDefaultLocationIds ?? []) as readonly string[],
      } satisfies InvitationDetail;
    },

    async rescind(invitationId) {
      // `revoked`, not a DELETE: the invitation is a compliance record of who was offered access, and
      // the M4 write-audit trigger on this table records the transition. The in-memory slice deleted
      // the row, which is why nothing could later answer "who invited this person, and who withdrew it".
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .update(I)
          .set({ status: "revoked" })
          .where(and(eq(I.id, invitationId), eq(I.status, "pending")))
          .returning({ id: I.id });
        return rows.length > 0;
      });
    },
  };
}

/** A canonical UUID — anything else cannot name a `user` row (and would 500 on the ::uuid cast). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB-backed §7.5 offboard: flip `users.status` to `deactivated`, bounded to one org (GAP-001).
 *
 * `reason` is deliberately NOT written to a column — `users` has none for it, and inventing one here
 * would put a free-text field that can name a person onto the identity row. The reason belongs in the
 * audit event the calling route already emits (`m2.user.deactivated`), which is redacted and retained.
 *
 * ATOMICITY. The cross-org membership check and the status flip run in ONE transaction that first takes
 * a row lock on the target `user` (`FOR UPDATE`). Every membership INSERT (invite accept, in any org)
 * runs the `membership.user_id` foreign-key check, which takes `FOR KEY SHARE` on that same user row —
 * a lock `FOR UPDATE` conflicts with. So an accept racing this call either committed before the lock
 * was granted (and the membership read below, a fresh READ COMMITTED snapshot, sees it → 409) or waits
 * until this transaction commits. Membership STATUS changes do not touch the FK; the only one that could
 * revive a membership is a PATCH out of `revoked`, which the route refuses (revocation is terminal).
 * The cross-org read is M2's `m2_list_own_memberships` SECURITY DEFINER function (migration 0231) —
 * `membership` RLS keys only on app.org_id, so wardenx_app cannot see other orgs' rows directly.
 */
export function createDbUserDirectory(db: DbClient): UserDirectory {
  const U = schema.users;
  const MB = schema.memberships;
  /** Every membership of `userId`, in every org, through the M2 SECURITY DEFINER read (0231). */
  const membershipsOf = async (tx: DbClient, userId: string): Promise<MembershipStanding[]> => {
    const result = await tx.execute(
      sql`SELECT organization_id, status FROM m2_list_own_memberships(${userId}::uuid)`,
    );
    return (
      (result as unknown as { rows?: { organization_id: string; status: MembershipStatus }[] })
        .rows ?? []
    ).map((r): MembershipStanding => ({ organizationId: r.organization_id, status: r.status }));
  };
  /**
   * §2.2.1 / §2.4 "all memberships revoked": revoke `userId`'s live membership(s) in each org, inside the
   * caller's transaction. `membership` RLS keys on `app.org_id`, so the GUC is re-pointed per org
   * (`set_config(_, _, true)` is transaction-local and may be set repeatedly); `app.user_id` gets the
   * system sentinel the other M2 system writes use. Returns the revoked rows.
   */
  const revokeMembershipsIn = async (
    tx: DbClient,
    userId: string,
    organizationIds: readonly string[],
  ): Promise<RevokedMembership[]> => {
    const revoked: RevokedMembership[] = [];
    for (const organizationId of organizationIds) {
      await tx.execute(sql`SELECT set_config('app.org_id', ${organizationId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id', '', true)`);
      const rows = await tx
        .update(MB)
        .set({ status: "revoked" })
        .where(
          and(
            eq(MB.userId, userId),
            eq(MB.organizationId, organizationId),
            ne(MB.status, "revoked"),
          ),
        )
        .returning({ membershipId: MB.id, organizationId: MB.organizationId });
      revoked.push(...rows);
    }
    return revoked;
  };
  return {
    async deactivateFromOrg({ userId, organizationId }) {
      if (!UUID_RE.test(userId)) return "not_member";
      return db.transaction(async (tx) => {
        const locked = await tx.select({ id: U.id }).from(U).where(eq(U.id, userId)).for("update");
        if (locked.length === 0) return "not_member";
        const outcome = decideOrgBoundedDeactivation(
          await membershipsOf(tx, userId),
          organizationId,
        );
        if (outcome !== "deactivated") return outcome;
        await tx.update(U).set({ status: "deactivated" }).where(eq(U.id, userId));
        await revokeMembershipsIn(tx as unknown as DbClient, userId, [organizationId]);
        return outcome;
      });
    },

    // §4.7 platform-wide offboard. `user` is NON_ORG_SCOPED (no RLS), so the lock + status flip need no
    // org context; the cross-org membership READ goes through the same SECURITY DEFINER function as
    // above, and each revoke WRITE runs with `app.org_id` pointed at that row's org (revokeMembershipsIn)
    // — wardenx_app still cannot touch another org's `membership` rows without naming it. Same `FOR UPDATE` as `deactivateFromOrg`, so the two serialize.
    async deactivateGlobally({ userId }) {
      if (!UUID_RE.test(userId)) {
        return { outcome: "not_found", memberOrganizationIds: [], revokedMemberships: [] };
      }
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: U.status })
          .from(U)
          .where(eq(U.id, userId))
          .for("update");
        if (!row) return { outcome: "not_found", memberOrganizationIds: [], revokedMemberships: [] };
        const memberOrganizationIds = liveMembershipOrganizationIds(
          await membershipsOf(tx, userId),
        );
        // The sweep runs on a repeat call too: a user deactivated before memberships were revoked
        // (or by the pre-§2.4 tenant route) is brought to the same end state.
        const revokedMemberships = await revokeMembershipsIn(
          tx as unknown as DbClient,
          userId,
          memberOrganizationIds,
        );
        if (row.status === "deactivated") {
          return { outcome: "already_deactivated", memberOrganizationIds, revokedMemberships };
        }
        await tx.update(U).set({ status: "deactivated" }).where(eq(U.id, userId));
        return { outcome: "deactivated", memberOrganizationIds, revokedMemberships };
      });
    },
  };
}
