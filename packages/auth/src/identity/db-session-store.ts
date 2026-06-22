import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
// @wardenx/auth · identity — DB-backed SessionContextStore (M2, AUTH-T05b, ADR-0033).
//
// Reads the M1 `session` table (where Better Auth writes the session + its additionalFields:
// activeOrganizationId, lastStepUpAt/Factor) so the SessionContextResolver resolves REAL sessions in
// production. Ownership-safe: it touches only the `session` table (the same M1 table the Better Auth
// drizzle adapter already reads/writes from this package) — it does NOT read M3's role/membership_role
// tables. `membershipId`/`roles` are enriched through an injected `ActorEnrichmentReader` (the M3-owned
// path: membership_role ⋈ role under RLS) when one is supplied; absent it (slice/tests), they stay empty
// and M3's effective-permission resolver still performs authorization independently (keyed userId+orgId).
import type {
  ActorEnrichment,
  ActorEnrichmentReader,
  OrgScope,
  StepUpFactor,
} from "@wardenx/types";
import { eq } from "drizzle-orm";
import type { SessionContextRecord, SessionContextStore } from "./session-seam";

/** The session-table columns this store reads. */
export interface SessionRow {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: string | null;
}

/** Pure: map a `session` row to a context record, merging optional M3 actor enrichment. Pre-org
 *  sessions map organizationId to "" so the resolver's org guard (`organizationId === scope.orgId`)
 *  yields null for them. Enrichment is applied only for the session's active org. */
export function toSessionContextRecord(
  row: SessionRow,
  sessionId: string,
  enrichment?: ActorEnrichment | null,
): SessionContextRecord {
  return {
    sessionId,
    userId: row.userId,
    membershipId: enrichment?.membershipId ?? null, // M3-owned path (membership_role/role) via the reader
    organizationId: row.activeOrganizationId ?? "",
    roles: enrichment?.roles ?? [], // authz still runs through M3's effective-permission resolver
    lastStepUpAt: row.lastStepUpAt ?? null,
    lastStepUpFactor: (row.lastStepUpFactor as StepUpFactor | null) ?? null,
  };
}

/**
 * Build a SessionContextStore over the live M1 `session` table. When an `ActorEnrichmentReader` is
 * supplied (production, the M3 Drizzle reader), the resolved actor's `membershipId`/`roles` are filled
 * for the request's org scope; without it the record keeps the empty defaults (slice/tests).
 */
export function createDbSessionContextStore(
  db: DbClient,
  enrich?: ActorEnrichmentReader,
): SessionContextStore {
  return {
    async read(scope: OrgScope, sessionId): Promise<SessionContextRecord | null> {
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
      if (!row) return null;
      // Enrich only when the session is bound to the requested org (the resolver's guard rejects a
      // mismatch anyway; this avoids an off-scope membership lookup).
      const enrichment =
        enrich && row.activeOrganizationId === scope.orgId
          ? await enrich.read(scope, row.userId)
          : null;
      return toSessionContextRecord(row, sessionId, enrichment);
    },
  };
}
