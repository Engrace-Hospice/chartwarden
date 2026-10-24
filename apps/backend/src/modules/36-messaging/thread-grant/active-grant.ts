// M36 ADR-0085 (PROPOSED), slice G1 - "does this user hold a LIVE thread grant for this request?". Not wired anywhere until G2.
// Per-tenant duration (`thread_access_grant_hours`, ADR-0085 decision 5) is registered in the M1 organization-settings registry
// (packages/db/src/organization-settings/settings-by-m36.ts); nothing reads it until G2 issues grants. The bounds are open (Q2).
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const G = schema.messageThreadAccessGrants;

export interface ThreadGrantFacts {
  readonly requestId: string;
  readonly granteeUserId: string;
  readonly revokedAt: Date | null;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Pure predicate over already-read rows (tests, and callers that hold rows). `now` MUST come from the database clock; a row that is
 * revoked, expired, not yet granted, or about another user or request behaves as absent.
 */
export function hasActiveThreadGrant(
  rows: readonly ThreadGrantFacts[],
  q: { readonly requestId: string; readonly granteeUserId: string; readonly now: Date },
): boolean {
  const t = q.now.getTime();
  return rows.some(
    (r) =>
      r.requestId === q.requestId &&
      r.granteeUserId === q.granteeUserId &&
      r.revokedAt === null &&
      r.grantedAt.getTime() <= t &&
      r.expiresAt.getTime() > t,
  );
}

/**
 * SQL-side check on the DATABASE clock (`now()`), never the application's. Run inside an org context (RLS scopes the rows).
 * Fail closed: any error is the caller's to treat as "no grant".
 */
export async function findActiveThreadGrant(
  db: Pick<DbClient, "select">,
  q: { readonly orgId: string; readonly requestId: string; readonly granteeUserId: string },
): Promise<{
  readonly id: string;
  readonly channelId: string;
  readonly rootMessageId: string;
} | null> {
  const [row] = await db
    .select({ id: G.id, channelId: G.channelId, rootMessageId: G.rootMessageId })
    .from(G)
    .where(
      and(
        eq(G.organizationId, q.orgId),
        eq(G.requestId, q.requestId),
        eq(G.granteeUserId, q.granteeUserId),
        isNull(G.revokedAt),
        sql`${G.grantedAt} <= now()`,
        sql`${G.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return row ?? null;
}
