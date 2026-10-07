// apps/backend/src/bootstrap/sole-tenant-user-resolver.ts — the D9 sole-tenant-user resolver
// (TASK-003 follow-up). M36's tenant-offboarding eraser deletes the per-USER messaging rows
// (presence / delivery endpoints / notification preferences) ONLY for users whose SOLE membership
// is the offboarding org — a user who also belongs to another tenant keeps their rows. `membership`
// is org-RLS'd, so a tenant connection can never prove the ABSENCE of a membership elsewhere:
// answering "sole tenant?" is inherently a cross-tenant read, and it runs here through ONE audited
// `withPlatformContext` entry (the active-org-enumerator precedent — every entry writes a
// `platform.bypass_invoked` row or refuses). M34's tenant shred resolves its identity-eraser subjects
// through this same resolver (under its own job id), so both erasers apply one D9 rule.
import { type DbClient, schema } from "@wardenx/db";
import type { PlatformBypassAuditor } from "@wardenx/tenancy";
import { withPlatformContext } from "@wardenx/tenancy";
import { and, eq, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export interface SoleTenantUserResolverDeps {
  /** The separately-pooled platform login role (the cross-tenant credential; NOT the tenant pool). */
  readonly platformDb: DbClient;
  /** Audits every withPlatformContext entry (fail-closed: an unaudited bypass throws). */
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  /** The registered platform job id (wire*Tenancy/registerPlatformJob registered it at boot). */
  readonly jobId: string;
}

/**
 * Build the `(orgId) => userIds` resolver M36's erase store consumes. Sole-tenant = the user has at
 * least one membership in `orgId` and ZERO memberships in any other org (any status — a suspended
 * membership elsewhere still means "not solely ours", the conservative direction: over-retaining a
 * user's own preference rows is recoverable; deleting another tenant's user state is not).
 */
export function buildSoleTenantUserResolver(
  deps: SoleTenantUserResolverDeps,
): (orgId: string) => Promise<readonly string[]> {
  const M = schema.memberships;
  return (orgId: string) =>
    withPlatformContext<DbClient, readonly string[]>(
      deps.platformDb,
      {
        jobId: deps.jobId,
        reason:
          "M36 D9 tenant-offboarding: resolve sole-tenant users (cross-tenant membership read)",
        crossTenant: true,
      },
      deps.auditBypass,
      async (tx) => {
        // The subquery goes through the query builder, not a raw `sql` template: interpolating an
        // `alias()` into raw SQL renders only `"other_membership"`, with no `"membership" AS` behind it.
        const OTHER = alias(M, "other_membership");
        const rows = await tx
          .selectDistinct({ userId: M.userId })
          .from(M)
          .where(
            and(
              eq(M.organizationId, orgId),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(OTHER)
                  .where(and(eq(OTHER.userId, M.userId), ne(OTHER.organizationId, orgId))),
              ),
            ),
          );
        return rows.map((r) => r.userId);
      },
    );
}
