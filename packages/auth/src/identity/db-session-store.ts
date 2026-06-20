// @wardenx/auth · identity — DB-backed SessionContextStore (M2, AUTH-T05b, ADR-0033).
//
// Reads the M1 `session` table (where Better Auth writes the session + its additionalFields:
// activeOrganizationId, lastStepUpAt/Factor) so the SessionContextResolver resolves REAL sessions in
// production. Ownership-safe: it touches only the `session` table (the same M1 table the Better Auth
// drizzle adapter already reads/writes from this package) — it does NOT read M3's role/membership_role
// tables. So `membershipId`/`roles` are left empty here; M3's effective-permission resolver performs
// authorization independently (keyed by userId + orgId). Enriching the actor with membership/roles is a
// follow-up that must go through an M3-owned path (no cross-module table access).
import type { StepUpFactor } from "@wardenx/types";
import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { eq } from "drizzle-orm";
import type { SessionContextRecord, SessionContextStore } from "./session-seam";

/** The session-table columns this store reads. */
export interface SessionRow {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: string | null;
}

/** Pure: map a `session` row to a context record. Pre-org sessions map organizationId to "" so the
 *  resolver's org guard (`organizationId === scope.orgId`) yields null for them. */
export function toSessionContextRecord(row: SessionRow, sessionId: string): SessionContextRecord {
  return {
    sessionId,
    userId: row.userId,
    membershipId: null, // enriched via M3 (membership_role/role are M3-owned — not read here)
    organizationId: row.activeOrganizationId ?? "",
    roles: [], // authz runs through M3's effective-permission resolver (userId + orgId)
    lastStepUpAt: row.lastStepUpAt ?? null,
    lastStepUpFactor: (row.lastStepUpFactor as StepUpFactor | null) ?? null,
  };
}

/** Build a SessionContextStore over the live M1 `session` table. */
export function createDbSessionContextStore(db: DbClient): SessionContextStore {
  return {
    async read(_scope, sessionId): Promise<SessionContextRecord | null> {
      const rows = await db
        .select({
          userId: schema.sessions.userId,
          activeOrganizationId: schema.sessions.activeOrganizationId,
          lastStepUpAt: schema.sessions.lastStepUpAt,
          lastStepUpFactor: schema.sessions.lastStepUpFactor,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      return row ? toSessionContextRecord(row, sessionId) : null;
    },
  };
}
