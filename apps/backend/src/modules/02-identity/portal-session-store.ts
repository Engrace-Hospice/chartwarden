import type { PortalSessionRow, PortalSessionStore } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/02-identity/portal-session-store.ts — the live `session`-row write surface
// behind M2's `PortalSessionBinder` seam (F-030 / #75).
//
// M2 owns the `session` row, so the class + scope writes M31 asks for happen here. Both operations are
// ORG-SCOPED in SQL, not just in the caller: the `read` predicate and the `update` predicate both carry
// `active_organization_id = :orgId`, so a session id belonging to another tenant is invisible to the
// read and untouched by the write — the seam's fail-closed shape is enforced by the query, not by a
// check the caller could skip.
//
// `scope` is jsonb and is MERGED rather than replaced (`COALESCE(scope,'{}') || patch`), because the
// two binder operations write different keys at different times: the account at mint, the patient at
// `select-patient`. A replacing write would silently drop whichever key it was not carrying.
import type { OrgScope } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";

/** Build the Drizzle-backed store. `db` is the M1 client; every statement is org-scoped inline. */
export function createDrizzlePortalSessionStore(db: DbClient): PortalSessionStore {
  return {
    async read(scope: OrgScope, sessionId: string): Promise<PortalSessionRow | null> {
      const rows = await db
        .select({
          organizationId: schema.sessions.activeOrganizationId,
          sessionClass: schema.sessions.sessionClass,
          scope: schema.sessions.scope,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.activeOrganizationId, scope.orgId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        organizationId: row.organizationId,
        sessionClass: row.sessionClass,
        scope: (row.scope as PortalSessionRow["scope"]) ?? null,
      };
    },

    async write(scope, sessionId, update) {
      // `||` on jsonb is a right-biased merge, so the patch wins per key and every other key survives.
      const patch = sql`COALESCE(${schema.sessions.scope}, '{}'::jsonb) || ${JSON.stringify(update.scopePatch)}::jsonb`;
      await db
        .update(schema.sessions)
        .set({
          ...(update.sessionClass ? { sessionClass: update.sessionClass } : {}),
          scope: patch,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.activeOrganizationId, scope.orgId),
          ),
        );
    },
  };
}
