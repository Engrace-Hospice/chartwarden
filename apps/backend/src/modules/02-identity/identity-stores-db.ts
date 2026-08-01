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
// token is never persisted and never leaves this module — which matches the column's intent and the
// route's comment that the token is emailed rather than returned.
//
// ⚠ KNOWN GAP, PRE-EXISTING AND UNCHANGED HERE: `InvitationStore.create` returns only
// `{ invitationId, expiresAt }`, so the raw token has no way out of the store, and nothing in
// `identity-routes.ts` calls an email transport. The route comment says "Token is emailed by the
// registered transactional sender" — no sender is wired, so an invitation cannot currently be
// accepted by anyone, in memory or in Postgres. Persisting it is still strictly better (the record
// survives, is visible to every replica, and is auditable); delivering it needs the port to return the
// token to a caller that can send it, which is an interface change beyond this fix.
import { type DbClient, schema } from "@wardenx/db";
import { and, count, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  type InvitationDetail,
  type InvitationStore,
  LinkError,
  type UserDirectory,
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
  return {
    async pendingExists(organizationId, email) {
      const rows = await db
        .select({ id: I.id })
        .from(I)
        .where(and(eq(I.organizationId, organizationId), eq(I.email, email), eq(I.status, "pending")))
        .limit(1);
      return rows.length > 0;
    },

    async pendingCount(organizationId) {
      const rows = await db
        .select({ n: count() })
        .from(I)
        .where(and(eq(I.organizationId, organizationId), eq(I.status, "pending")));
      return Number(rows[0]?.n ?? 0);
    },

    async create(input) {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      const rows = await db
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
      return { invitationId: row.id, expiresAt: row.expiresAt.toISOString() };
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
      const rows = await db
        .update(I)
        .set({ status: "revoked" })
        .where(and(eq(I.id, invitationId), eq(I.status, "pending")))
        .returning({ id: I.id });
      return rows.length > 0;
    },
  };
}

/**
 * DB-backed §7.5 offboard: flip `users.status` to `deactivated`.
 *
 * `reason` is deliberately NOT written to a column — `users` has none for it, and inventing one here
 * would put a free-text field that can name a person onto the identity row. The reason belongs in the
 * audit event the calling route already emits (`m2.user.deactivated`), which is redacted and retained.
 */
export function createDbUserDirectory(db: DbClient): UserDirectory {
  const U = schema.users;
  return {
    async deactivate(userId, _reason) {
      await db.update(U).set({ status: "deactivated" }).where(eq(U.id, userId));
    },
  };
}
