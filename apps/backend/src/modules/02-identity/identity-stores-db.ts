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
import { and, count, desc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  type InvitationDetail,
  type InvitationListItem,
  type InvitationStore,
  LinkError,
  type MintedInvitation,
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

    async list(organizationId) {
      const rows = await db
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
      return { invitationId: row.id, token, expiresAt: row.expiresAt.toISOString() };
    },

    async resend(invitationId): Promise<MintedInvitation | null> {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      // The status predicate is part of the UPDATE (same atomic-guard pattern as `consume`/`rescind`):
      // re-minting a no-longer-pending invite (already accepted/revoked) is refused, not resurrected.
      const rows = await db
        .update(I)
        .set({ tokenHash: hashToken(token), expiresAt })
        .where(and(eq(I.id, invitationId), eq(I.status, "pending")))
        .returning({ id: I.id, expiresAt: I.expiresAt });
      const row = rows[0];
      if (!row) return null;
      return { invitationId: row.id, token, expiresAt: row.expiresAt.toISOString() };
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
