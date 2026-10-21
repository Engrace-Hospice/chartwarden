// apps/backend/src/modules/03-authorization/engagement-reader.ts — M3's published `AuditorEngagementReader`
// (GAP-093(a)), over the M3-owned `auditor_engagement` table. M31's `portal_engagement_scope` predicate and
// the auditor view's coverage resolution consume it through `getSeam` (no dependsOn edge, ADR-0005 D1).
//
// Org-scoped TWICE: the read runs under `withOrgContext` (RLS on `app.org_id`) and the query also carries
// `organization_id = :orgId`, so another tenant's engagement id is simply "not found". A database error is
// NOT swallowed here — it propagates, and the consumers (the predicate's catch, the handler's 403) fail
// closed on a throw, exactly as they do on the unbound deny-stub.
//
// KNOWN GAP (reported, needs a migration): the contract says "the auditor was enrolled for this engagement",
// but no enrolment table exists — `auditor_engagement` holds the engagement only, and the invite's magic-link
// token is not persisted anywhere. Enrolment is therefore carried by the SESSION: the engagement id the
// caller passes is the one stamped from `session.scope.engagementId` (M2-written, class-gated, never a
// request field). Until M2 writes it at magic-link consumption no live session carries one, so this reader is
// never reached for a real auditor — the route denies everyone. A real `engagement ↔ auditor user` row would
// let this reader also check the user.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { AuditorEngagementReader, EngagementCoverage } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { isEngagementLive, parseEngagementCoverage } from "./engagement-scope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReadInput {
  organizationId: string;
  engagementId: string;
  auditorUserId: string;
  at: string;
}

/** Build the reader. `db` is the pooled M1 client; each read is org-scoped under RLS. */
export function createDbAuditorEngagementReader(db: DbClient): AuditorEngagementReader {
  /** The engagement's coverage when it is live for this auditor, else null (never throws for "no"). */
  async function liveCoverage(input: ReadInput): Promise<EngagementCoverage | null> {
    if (!input.auditorUserId || !UUID_RE.test(input.engagementId)) return null;
    const at = new Date(input.at);
    if (Number.isNaN(at.getTime())) return null;
    const rows = await withOrgContext(
      db,
      { organizationId: input.organizationId, userId: input.auditorUserId },
      (tx) =>
        tx
          .select({
            organizationId: schema.auditorEngagements.organizationId,
            status: schema.auditorEngagements.status,
            startAt: schema.auditorEngagements.startAt,
            endAt: schema.auditorEngagements.endAt,
            scope: schema.auditorEngagements.scope,
          })
          .from(schema.auditorEngagements)
          .where(
            and(
              eq(schema.auditorEngagements.id, input.engagementId),
              eq(schema.auditorEngagements.organizationId, input.organizationId),
            ),
          )
          .limit(1),
    );
    const row = rows[0];
    if (!row || !isEngagementLive(row, input.organizationId, at)) return null;
    return parseEngagementCoverage(row.scope);
  }

  return {
    async isEngagementActiveForAuditor(input) {
      return (await liveCoverage(input)) !== null;
    },
    engagementScope: liveCoverage,
  };
}
