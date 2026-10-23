// apps/backend/src/modules/36-messaging/analytics/response-analytics-reader.ts - WP 6.2 (ADR-0092): the aggregate response analytics M36
// publishes as the `MessagingResponseAnalyticsReader` seam (M33 serves the route).
//
// Reads only M36's own tables (acknowledgment request/event, clinical_handoff) inside the caller's tenant context (FORCE RLS plus an
// explicit organization_id filter). The one cross-module read is the assignee's role KEY (membership/role: the sanctioned identity join),
// used to name a discipline group; the person is never selected into the result. Output is counts, rates and medians only; groups and the
// handoff median are held back unless at least ANALYTICS_MIN_COHORT distinct people (and, for groups, ANALYTICS_MIN_REQUESTS requests) stand behind them.
// Only settled requests are counted (see requestsCte).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ANALYTICS_MAX_PERSON_SHARE,
  ANALYTICS_MIN_COHORT,
  ANALYTICS_MIN_REQUESTS,
  type AnalyticsGroupBy,
  type MessagingResponseAnalyticsReader,
  RESPONSE_ANALYTICS_FLAG_KEY,
  type ResponseAnalyticsKpis,
  type ResponseAnalyticsReport,
} from "@chartwarden/types";
import { type SQL, and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import { type RawGroupRow, applyCohortFloor, clearsFloor } from "./cohort-floor";

export interface ResponseAnalyticsFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

interface GroupSqlRow extends Record<string, unknown> {
  grp: string;
  members: string[];
  requests: string | number;
  acknowledged: string | number;
  in_time: string | number;
  escalated: string | number;
  median_ack: string | number | null;
}

const num = (v: string | number): number => Number(v);
const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const medianOf = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** Start of the current UTC day by the DATABASE clock: the boundary of "settled" (a window `to` is never later than it). */
const SETTLED_BEFORE = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * Requests opened in [from, to) that are SETTLED, cancelled ones excluded, each with its escalation fact and the assignee's discipline. The discipline comes
 * from `disciplines` (a jsonb array of {user_id, discipline} built through the identity schema, see {@link disciplineMap}), never a join here.
 *
 * SETTLED (ADR-0092 D6 g): only requests that are acknowledged or resolved AND whose last change (the request row and its newest event) is
 * before the start of the current UTC day. A request still open, or one that changed today, is not in any figure, so the answer for a given
 * window is identical all day and a poller cannot watch one acknowledgment (or escalation) arrive; changes surface only at the UTC day
 * boundary, in batches of a whole day.
 */
function requestsCte(orgId: string, from: string, to: string, disciplines: string): SQL {
  return sql`
    req AS (
      SELECT r.assigned_user_id, r.ack_class::text AS ack_class, r.requested_at, r.deadline_at, r.acknowledged_at,
             EXISTS (SELECT 1 FROM message_acknowledgment_event e
                      WHERE e.organization_id = r.organization_id AND e.request_id = r.id
                        AND e.event_type = 'escalated') AS was_escalated,
             d.discipline
        FROM message_acknowledgment_request r
        LEFT JOIN jsonb_to_recordset(${disciplines}::jsonb) AS d(user_id uuid, discipline text)
          ON d.user_id = r.assigned_user_id
       WHERE r.organization_id = ${orgId}::uuid
         AND r.requested_at >= ${from}::timestamptz AND r.requested_at < ${to}::timestamptz
         AND r.status IN ('acknowledged', 'resolved')
         AND r.updated_at < ${SETTLED_BEFORE}
         AND NOT EXISTS (SELECT 1 FROM message_acknowledgment_event e2
                          WHERE e2.organization_id = r.organization_id AND e2.request_id = r.id
                            AND e2.created_at >= ${SETTLED_BEFORE})
    )`;
}

const FLOOR_LIMITS = {
  minCohort: ANALYTICS_MIN_COHORT,
  minRequests: ANALYTICS_MIN_REQUESTS,
  maxPersonShare: ANALYTICS_MAX_PERSON_SHARE,
} as const;

const NO_DISCIPLINES = "[]";

/**
 * user -> discipline for the org: the alphabetically first clinical role key the person holds now (deterministic; a person with two clinical
 * roles counts in one group only). Read through the identity schema (the sanctioned membership/role join); the map is used inside this module
 * to name a group and is never returned.
 */
async function disciplineMap(tx: Tx, orgId: string): Promise<string> {
  const rows = await tx
    .select({
      user_id: schema.memberships.userId,
      discipline: sql<string>`min(${schema.roles.key})`,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.membershipRoles,
      eq(schema.membershipRoles.membershipId, schema.memberships.id),
    )
    .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
    .where(
      and(
        eq(schema.memberships.organizationId, orgId),
        eq(schema.roles.category, "clinical_staff"),
        or(
          isNull(schema.membershipRoles.expiresAt),
          gt(schema.membershipRoles.expiresAt, sql`now()`),
        ),
      ),
    )
    .groupBy(schema.memberships.userId);
  return JSON.stringify(rows);
}

const AGGREGATES = sql`
  array_agg(assigned_user_id) AS members,
  count(*) AS requests,
  count(acknowledged_at) AS acknowledged,
  count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= deadline_at) AS in_time,
  count(*) FILTER (WHERE was_escalated) AS escalated,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (acknowledged_at - requested_at)))
    FILTER (WHERE acknowledged_at IS NOT NULL) AS median_ack`;

function toRaw(r: GroupSqlRow): RawGroupRow {
  const requests = num(r.requests);
  return {
    group: r.grp,
    members: r.members,
    requests,
    acknowledged: num(r.acknowledged),
    ackedBeforeDeadlineRate: rate(num(r.in_time), requests),
    escalationRate: rate(num(r.escalated), requests),
    medianAckSeconds: medianOf(r.median_ack),
  };
}

export function createResponseAnalyticsReader(deps: {
  readonly db: DbClient;
  readonly flags: ResponseAnalyticsFlagReader;
}): MessagingResponseAnalyticsReader {
  async function groups(
    tx: Tx,
    orgId: string,
    from: string,
    to: string,
    groupBy: AnalyticsGroupBy,
  ): Promise<RawGroupRow[]> {
    const disciplines = groupBy === "discipline" ? await disciplineMap(tx, orgId) : NO_DISCIPLINES;
    const key = groupBy === "class" ? sql`ack_class` : sql`coalesce(discipline, 'unspecified')`;
    const res = await tx.execute<GroupSqlRow>(sql`
      WITH ${requestsCte(orgId, from, to, disciplines)}
      SELECT ${key} AS grp, ${AGGREGATES} FROM req GROUP BY 1 ORDER BY 1`);
    return res.rows.map(toRaw);
  }

  return {
    enabled: async (organizationId) =>
      (await deps.flags.forOrg(organizationId))[RESPONSE_ANALYTICS_FLAG_KEY] === true,

    async report(organizationId, { from, to, groupBy }): Promise<ResponseAnalyticsReport> {
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      return withOrgContext(deps.db, systemOrgContext(organizationId), async (txRaw) => {
        const tx = txRaw as unknown as Tx;
        const total = await tx.execute<GroupSqlRow>(sql`
          WITH ${requestsCte(organizationId, fromIso, toIso, NO_DISCIPLINES)}
          SELECT 'all' AS grp, ${AGGREGATES} FROM req`);
        const all = total.rows[0] ? toRaw(total.rows[0]) : null;
        // The whole report is held back when the organisation-wide cohort fails the cell floor (people, requests, one-person share) and so is too small to be anything but an individual's record.
        if (!all || !clearsFloor(all, FLOOR_LIMITS)) {
          return { status: "insufficient_data", minCohort: ANALYTICS_MIN_COHORT } as const;
        }
        const handoff = await tx.execute<{
          offered: string | number;
          accepted: string | number;
          recipients: string | number;
          median_accept: string | number | null;
        }>(sql`
          SELECT count(*) AS offered,
                 count(*) FILTER (WHERE state = 'accepted') AS accepted,
                 count(DISTINCT to_user_id) AS recipients,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (accepted_at - offered_at)))
                   FILTER (WHERE accepted_at IS NOT NULL) AS median_accept
            FROM clinical_handoff
           WHERE organization_id = ${organizationId}::uuid
             AND offered_at >= ${fromIso}::timestamptz AND offered_at < ${toIso}::timestamptz
             AND state <> 'offered' AND updated_at < ${SETTLED_BEFORE}`);
        const h = handoff.rows[0];
        const handoffCohortOk = h !== undefined && num(h.recipients) >= ANALYTICS_MIN_COHORT;
        const kpis: ResponseAnalyticsKpis = {
          requests: all.requests,
          acknowledged: all.acknowledged,
          ackedBeforeDeadlineRate: all.ackedBeforeDeadlineRate,
          escalationRate: all.escalationRate,
          medianAckSeconds: all.medianAckSeconds,
          handoffsOffered: handoffCohortOk && h ? num(h.offered) : null,
          handoffsAccepted: handoffCohortOk && h ? num(h.accepted) : null,
          medianHandoffAcceptSeconds: handoffCohortOk && h ? medianOf(h.median_accept) : null,
        };
        const floored = applyCohortFloor(
          await groups(tx, organizationId, fromIso, toIso, groupBy),
          FLOOR_LIMITS,
        );
        return {
          status: "ok",
          from: fromIso,
          to: toIso,
          minCohort: ANALYTICS_MIN_COHORT,
          groupBy,
          kpis,
          cells: floored.cells,
          suppressedGroups: floored.suppressedGroups,
          breakdownWithheld: floored.withheld,
        } as const;
      });
    },
  };
}
