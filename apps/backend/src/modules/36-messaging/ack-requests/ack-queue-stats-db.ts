// apps/backend/src/modules/36-messaging/ack-requests/ack-queue-stats-db.ts - WP 4.9 (ADR-0076): the numbers behind the ops gauges and
// the threshold notice, for ONE organisation. Counts and durations only (no id, no patient, no text), read as the system actor under
// the organisation's RLS context. Never writes. The caller sums or maximises across organisations; a per-request or per-user figure
// never leaves this function.
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, sql } from "drizzle-orm";
import { WAITING } from "./unacknowledged-reader-db";

const R = schema.messageAckRequests;

/** Acknowledgments counted for the latency gauges: those made in the trailing window. */
export const ACK_LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AckQueueStats {
  /** Waiting requests (pending, escalated, failed_unreachable) past their deadline. */
  readonly overdue: number;
  readonly failedUnreachable: number;
  /** Seconds the longest-overdue waiting request is past its deadline; 0 when none is. */
  readonly oldestOverdueSeconds: number;
  /** Acknowledgments in the trailing window: how many, and the sum and maximum of (acknowledged_at - requested_at) in seconds. */
  readonly ackedCount: number;
  readonly ackLatencySumSeconds: number;
  readonly ackLatencyMaxSeconds: number;
}

export type AckQueueStatsReader = (orgId: string, now: Date) => Promise<AckQueueStats>;

export function createDbAckQueueStatsReader(db: DbClient): AckQueueStatsReader {
  return (orgId, now) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const nowIso = now.toISOString();
      const [waiting] = await tx
        .select({
          overdue: sql<number>`(count(*) FILTER (WHERE ${R.deadlineAt} <= ${nowIso}::timestamptz))::int`,
          failed: sql<number>`(count(*) FILTER (WHERE ${R.status} = 'failed_unreachable'))::int`,
          oldest: sql<number>`coalesce(max(extract(epoch FROM (${nowIso}::timestamptz - ${R.deadlineAt}))) FILTER (WHERE ${R.deadlineAt} <= ${nowIso}::timestamptz), 0)::float8`,
        })
        .from(R)
        .where(and(eq(R.organizationId, orgId), WAITING));
      const since = new Date(now.getTime() - ACK_LATENCY_WINDOW_MS);
      const [acked] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          sum: sql<number>`coalesce(sum(extract(epoch FROM (${R.acknowledgedAt} - ${R.requestedAt}))), 0)::float8`,
          max: sql<number>`coalesce(max(extract(epoch FROM (${R.acknowledgedAt} - ${R.requestedAt}))), 0)::float8`,
        })
        .from(R)
        .where(and(eq(R.organizationId, orgId), gte(R.acknowledgedAt, since)));
      return {
        overdue: waiting?.overdue ?? 0,
        failedUnreachable: waiting?.failed ?? 0,
        oldestOverdueSeconds: Math.max(0, Math.floor(waiting?.oldest ?? 0)),
        ackedCount: acked?.n ?? 0,
        ackLatencySumSeconds: acked?.sum ?? 0,
        ackLatencyMaxSeconds: acked?.max ?? 0,
      };
    });
}
