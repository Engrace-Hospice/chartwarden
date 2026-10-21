// apps/backend/src/modules/33-reporting/abac-resolver-db.ts — the PRODUCTION `ReportingAbacResolver`
// (M33 §4.7), over Drizzle under the tenant's own RLS scope.
//
// F-044: the composition root called `registerM33AbacPredicates()` with NO argument, so both §4.7
// predicates ran against `denyStubReportingAbacResolver` in production. Its `loadReportView` returns
// `null` unconditionally, and `dashboard_visibility` reads that as "absent / cross-tenant row" and
// DENIES — so `GET /reporting/dashboards/:id` (which mounts the predicate with `notFoundOnDeny: true`)
// answered 404 for every caller including a dashboard's own owner, and every views/shares route mounting
// the same predicate refused the same way. Fail-closed and therefore invisible: a dashboard nobody may
// see and a dashboard the resolver cannot load are the same 404.
//
// The team/location reach is STILL fail-closed, and that is a declared absence rather than an oversight:
// M3 now registers a `SupervisorReader` seam, but NO consumer reads it yet and this resolver does not either:
// `resolveSupervisedMembershipIds` stays a deny-stub on purpose until the supervision definition is tightened
// (the grant's scope is ignored, and locations come from the membership's default_location_ids). With it
// unbound every actor without org-wide authority resolves to `self` — the narrowest scope, which is the
// correct answer to "I cannot establish that you supervise anyone". Once the definition is tightened,
// `supervised` becomes a `getSeam` call here and nothing else moves.
import { schema } from "@chartwarden/db";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type {
  ReportScheduleFacts,
  ReportViewFacts,
  ReportingAbacResolver,
} from "./abac-predicates";

/**
 * Build the Drizzle-backed §4.7 resolver. Every read opens the caller's own `withOrgContext`, so RLS
 * backstops the org predicate rather than this code being trusted to apply it — the org id is compared
 * again here only so a row that somehow crossed cannot be projected.
 */
export function buildDrizzleReportingAbacResolver(db: DbClient): ReportingAbacResolver {
  return {
    async loadReportView(organizationId: string, viewId: string): Promise<ReportViewFacts | null> {
      if (!organizationId || !viewId) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.reportView)
          .where(
            and(
              eq(schema.reportView.id, viewId),
              eq(schema.reportView.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!row) return null;
        return {
          viewId: row.id,
          organizationId: row.organizationId,
          ownerMembershipId: row.ownerMembershipId,
          shareScope: row.shareScope,
          shareRoleKeys: row.shareRoleKeys ?? [],
        };
      });
    },

    async loadReportSchedule(
      organizationId: string,
      scheduleId: string,
    ): Promise<ReportScheduleFacts | null> {
      if (!organizationId || !scheduleId) return null;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.reportSchedule)
          .where(
            and(
              eq(schema.reportSchedule.id, scheduleId),
              eq(schema.reportSchedule.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!row) return null;
        return {
          scheduleId: row.id,
          organizationId: row.organizationId,
          ownerMembershipId: row.ownerMembershipId,
          recipientMembershipIds: row.recipientMembershipIds ?? [],
        };
      });
    },

    // Deny-stub on purpose (M3's SupervisorReader is registered but unread) — see the file header. Fail-closed: no supervised
    // set, so the §4.7.1 ladder falls through to `self` rather than inventing a team.
    async resolveSupervisedMembershipIds() {
      return [];
    },
    async isSupervisorForLocation() {
      return false;
    },
  };
}
