// apps/backend/src/modules/36-messaging/ack-requests/ack-queue-stats-db.ts - WP 4.9 (ADR-0076): the numbers behind the ops gauges and
// the threshold notice, for ONE organisation. Counts and durations only (no id, no patient, no text), read as the system actor under
// the organisation's RLS context. Never writes. The caller sums or maximises across organisations; a per-request or per-user figure
// never leaves this function.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { unroutedBackoffElapsed } from "./ack-store-db";
import { WAITING } from "./unacknowledged-reader-db";

const R = schema.messageAckRequests;

/** Acknowledgments counted for the latency gauges: those made in the trailing window. */
export const ACK_LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STATS_STATEMENT_TIMEOUT_MS = 5_000;

export interface AckQueueStats {
  /** Waiting requests (pending, escalated, failed_unreachable) past their deadline. */
  readonly overdue: number;
  readonly failedUnreachable: number;
  /** Seconds the longest-overdue waiting request is past its deadline; 0 when none is. */
  readonly oldestOverdueSeconds: number;
  /**
   * ADR-0079 (G-4): seconds the oldest request the escalation sweep SHOULD have handled by now is past its deadline (pending or escalated,
   * overdue, not in its unroutable backoff); 0 when none is, and 0 when the tenant's `messaging.escalation_timers` is off (the action is
   * off by design, so nothing is stalled). A healthy worker clears such a request within about two sweep ticks, so a large value means the
   * timer job and the sweep are both not running (or failing for this organisation), as opposed to nobody answering.
   */
  readonly escalationStalledSeconds: number;
  /** Acknowledgments in the trailing window: how many, and the sum and maximum of (acknowledged_at - requested_at) in seconds. */
  readonly ackedCount: number;
  readonly ackLatencySumSeconds: number;
  readonly ackLatencyMaxSeconds: number;
}

export type AckQueueStatsReader = (orgId: string, now: Date) => Promise<AckQueueStats>;

export interface AckQueueStatsReaderOptions {
  /** `messaging.escalation_timers` for the organisation; absent = treated as on (the stalled figure is measured). A throw fails the read. */
  readonly isEscalationEnabled?: (orgId: string) => Promise<boolean>;
}

export function createDbAckQueueStatsReader(
  db: DbClient,
  options: AckQueueStatsReaderOptions = {},
): AckQueueStatsReader {
  return async (orgId, now) => {
    const escalationOn = (await options.isEscalationEnabled?.(orgId)) ?? true;
    return readStats(db, orgId, now, escalationOn);
  };
}

function readStats(
  db: DbClient,
  orgId: string,
  now: Date,
  escalationOn: boolean,
): Promise<AckQueueStats> {
  return withOrgContext(db, systemOrgContext(orgId), async (tx) => {
    // A hung query must end on its own: the gauges' in-flight guard waits for it (and gives up after 3 timeouts).
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${String(STATS_STATEMENT_TIMEOUT_MS)}, true)`,
    );
    const nowIso = now.toISOString();
    const [waiting] = await tx
      .select({
        overdue: sql<number>`(count(*) FILTER (WHERE ${R.deadlineAt} <= ${nowIso}::timestamptz))::int`,
        failed: sql<number>`(count(*) FILTER (WHERE ${R.status} = 'failed_unreachable'))::int`,
        oldest: sql<number>`coalesce(max(extract(epoch FROM (${nowIso}::timestamptz - ${R.deadlineAt}))) FILTER (WHERE ${R.deadlineAt} <= ${nowIso}::timestamptz), 0)::float8`,
      })
      .from(R)
      .where(and(eq(R.organizationId, orgId), WAITING));
    const [stalled] = escalationOn
      ? await tx
          .select({
            oldest: sql<number>`coalesce(max(extract(epoch FROM (${nowIso}::timestamptz - ${R.deadlineAt}))), 0)::float8`,
          })
          .from(R)
          .where(
            and(
              eq(R.organizationId, orgId),
              inArray(R.status, ["pending", "escalated"]),
              sql`${R.deadlineAt} <= ${nowIso}::timestamptz`,
              unroutedBackoffElapsed(now),
            ),
          )
      : [];
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
      escalationStalledSeconds: Math.max(0, Math.floor(stalled?.oldest ?? 0)),
      ackedCount: acked?.n ?? 0,
      ackLatencySumSeconds: acked?.sum ?? 0,
      ackLatencyMaxSeconds: acked?.max ?? 0,
    };
  });
}
