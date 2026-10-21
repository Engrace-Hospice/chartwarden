// apps/backend/src/modules/29-external-interfaces/listener/health-store-drizzle.ts — GAP-043. The Drizzle
// `FeedHealthStorePort`: reads the latest breaker state + newest inbound frame, and upserts the hourly
// `external_feed_health` row, all under the feed's own org context (tenant RLS, the `app.org_id` GUC).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import type { ListenerCircuitState } from "./circuit-breaker";
import type { FeedHealthStorePort } from "./health-sweep";

const HEALTH = schema.externalFeedHealth;
const LISTENER_STATE = schema.externalFeedListenerState;
const INBOUND = schema.hl7MessageInbound;
const OUTBOUND = schema.hl7MessageOutbound;
const SYSTEM_USER_ID = "";
const HOUR_MS = 3_600_000;

const CIRCUIT_STATES: readonly ListenerCircuitState[] = ["closed", "open", "half_open"];
const asState = (value: string | undefined): ListenerCircuitState =>
  CIRCUIT_STATES.find((s) => s === value) ?? "closed";

export function createDrizzleFeedHealthStore(deps: { readonly db: DbClient }): FeedHealthStorePort {
  const inOrg = <T>(organizationId: string, work: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
      work(tx as DbClient),
    );

  return {
    snapshot(feed) {
      return inOrg(feed.organizationId, async (tx) => {
        const [latest] = await tx
          .select({ state: HEALTH.listenerCircuitState })
          .from(HEALTH)
          .where(and(eq(HEALTH.organizationId, feed.organizationId), eq(HEALTH.feedId, feed.id)))
          .orderBy(desc(HEALTH.hourBucket))
          .limit(1);
        const [frame] = await tx
          .select({ at: sql<Date | null>`max(${INBOUND.receivedAt})` })
          .from(INBOUND)
          .where(and(eq(INBOUND.organizationId, feed.organizationId), eq(INBOUND.feedId, feed.id)));
        return {
          state: asState(latest?.state),
          lastFrameAtMs: frame?.at ? new Date(frame.at).getTime() : null,
        };
      });
    },

    async heartbeat(feed, fact) {
      await inOrg(feed.organizationId, async (tx) => {
        // Only the listener-owned columns: the watcher's circuit_state / outage_opened_at are never touched here.
        await tx
          .insert(LISTENER_STATE)
          .values({
            feedId: feed.id,
            organizationId: feed.organizationId,
            listenerHeartbeatAt: fact.at,
            listenerBound: fact.bound,
          })
          .onConflictDoUpdate({
            target: LISTENER_STATE.feedId,
            set: { listenerHeartbeatAt: fact.at, listenerBound: fact.bound, updatedAt: fact.at },
          });
      });
    },

    async record(feed, row) {
      await inOrg(feed.organizationId, async (tx) => {
        const from = row.hourBucket;
        const to = new Date(from.getTime() + HOUR_MS);
        const [inbound] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            parseErrors: sql<number>`count(*) filter (where ${INBOUND.parseStatus} = 'parse_error')::int`,
            lastAt: sql<Date | null>`max(${INBOUND.receivedAt})`,
          })
          .from(INBOUND)
          .where(
            and(
              eq(INBOUND.organizationId, feed.organizationId),
              eq(INBOUND.feedId, feed.id),
              gte(INBOUND.receivedAt, from),
              lt(INBOUND.receivedAt, to),
            ),
          );
        const [outbound] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(OUTBOUND)
          .where(
            and(
              eq(OUTBOUND.organizationId, feed.organizationId),
              eq(OUTBOUND.feedId, feed.id),
              gte(OUTBOUND.queuedAt, from),
              lt(OUTBOUND.queuedAt, to),
            ),
          );
        const counts = {
          inboundMessageCount: inbound?.total ?? 0,
          parseErrorCount: inbound?.parseErrors ?? 0,
          outboundMessageCount: outbound?.total ?? 0,
          lastMessageAt: inbound?.lastAt ? new Date(inbound.lastAt) : null,
        };
        await tx
          .insert(HEALTH)
          .values({
            feedId: feed.id,
            hourBucket: from,
            organizationId: feed.organizationId,
            listenerUpSeconds: row.upSecondsDelta,
            listenerDownSeconds: row.downSecondsDelta,
            ...(row.state === undefined ? {} : { listenerCircuitState: row.state }),
            ...counts,
          })
          .onConflictDoUpdate({
            target: [HEALTH.feedId, HEALTH.hourBucket],
            set: {
              listenerUpSeconds: sql`${HEALTH.listenerUpSeconds} + ${row.upSecondsDelta}`,
              listenerDownSeconds: sql`${HEALTH.listenerDownSeconds} + ${row.downSecondsDelta}`,
              ...(row.state === undefined ? {} : { listenerCircuitState: row.state }),
              ...counts,
            },
          });
      });
    },
  };
}
