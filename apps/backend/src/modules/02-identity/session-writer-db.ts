// apps/backend/src/modules/02-identity — DB-backed SessionWriter (org-bind / revoke).
//
// Replaces the in-memory session writer slice: `select-organization` must persist the active org to
// the Better Auth `session` row, because the authenticate hook reads it back via `auth.api.getSession`
// (getIdentitySession). Without this the binding never reaches request.context and org-scoped routes
// 401. Foundation `session` is not org-RLS'd; runs on the app connection.
import type { DbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import type { SessionWriter } from "./identity-ports";

export function createDbSessionWriter(db: DbClient): SessionWriter {
  return {
    async bindOrganization({ sessionId, organizationId, organizationName }) {
      const res = await db.execute(sql`
        UPDATE "session" SET active_organization_id = ${organizationId}::uuid
        WHERE id = ${sessionId}
        RETURNING expires_at`);
      const row = (res.rows?.[0] ?? {}) as { expires_at?: string | Date };
      const expiresAt = row.expires_at ?? new Date(Date.now() + 12 * 3600 * 1000);
      return {
        activeOrganizationId: organizationId,
        organizationName,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    async revokeForMembership(membershipId) {
      const res = await db.execute(sql`
        DELETE FROM "session"
        WHERE user_id = (SELECT user_id FROM membership WHERE id = ${membershipId}::uuid)`);
      return res.rowCount ?? 0;
    },
    async revokeAllForUser(userId) {
      const res = await db.execute(sql`DELETE FROM "session" WHERE user_id = ${userId}::uuid`);
      return res.rowCount ?? 0;
    },
  };
}
