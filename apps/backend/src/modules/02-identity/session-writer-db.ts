// apps/backend/src/modules/02-identity — DB-backed SessionWriter (org-bind / revoke).
//
// Replaces the in-memory session writer slice: `select-organization` must persist the active org to
// the Better Auth `session` row, because the authenticate hook reads it back via `auth.api.getSession`
// (getIdentitySession). Without this the binding never reaches request.context and org-scoped routes
// 401. Reads the M1-owned `membership` only to map a membershipId → its user for revoke (M2 dependsOn
// M1; via the Drizzle query builder, never raw SQL — mirrors membership-repository.ts). Foundation
// `session`/`membership` are not org-RLS'd; runs on the app connection.
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import type { SessionWriter } from "./identity-ports";

export function createDbSessionWriter(db: DbClient): SessionWriter {
  return {
    async bindOrganization({ sessionId, organizationId, organizationName }) {
      const rows = await db
        .update(schema.sessions)
        .set({ activeOrganizationId: organizationId })
        .where(eq(schema.sessions.id, sessionId))
        .returning({ expiresAt: schema.sessions.expiresAt });
      const expiresAt = rows[0]?.expiresAt ?? new Date(Date.now() + 12 * 3600 * 1000);
      return {
        activeOrganizationId: organizationId,
        organizationName,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    async revokeForMembership(membershipId) {
      const [m] = await db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, membershipId));
      if (!m) return 0;
      const revoked = await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, m.userId))
        .returning({ id: schema.sessions.id });
      return revoked.length;
    },
    async revokeAllForUser(userId) {
      const revoked = await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId))
        .returning({ id: schema.sessions.id });
      return revoked.length;
    },
  };
}
