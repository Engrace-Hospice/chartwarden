// apps/backend/src/modules/29-external-interfaces/listener/health-watch-store-drizzle.ts - GAP-043. The Drizzle
// `FeedWatchStore`: reads the watchable feeds (feed + listener-state row + newest inbound frame) and applies a transition
// - the state row, the current hour's health row and the outbox event - in ONE `withOrgContext` transaction, as the
// feed's own tenant (RLS on `app.org_id`). The watcher runs in the worker role as `chartwarden_app`.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";

import type { M29WriteOutboxPort } from "../routes/store-drizzle";
import type { ListenerCircuitState } from "./circuit-breaker";
import { hourBucketOf } from "./health-sweep";
import type { FeedWatchStore, WatchedFeed } from "./health-watch";

const STATE = schema.externalFeedListenerState;
const HEALTH = schema.externalFeedHealth;
const SYSTEM_USER_ID = "";

const CIRCUIT_STATES: readonly ListenerCircuitState[] = ["closed", "open", "half_open"];
const asState = (value: unknown): ListenerCircuitState =>
  CIRCUIT_STATES.find((s) => s === value) ?? "closed";
const asDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

interface WatchRow {
  readonly feedId: string;
  readonly organizationId: string;
  readonly port: number;
  readonly activatedAt: string | Date;
  readonly thresholdSeconds: number | null;
  readonly quietWindows: unknown;
  readonly heartbeatAt: string | Date | null;
  readonly listenerBound: boolean | null;
  readonly circuitState: string | null;
  readonly outageOpenedAt: string | Date | null;
  readonly lastFrameAt: string | Date | null;
}

export function createDrizzleFeedWatchStore(deps: {
  readonly db: DbClient;
  readonly outbox: M29WriteOutboxPort;
}): FeedWatchStore {
  return {
    async listWatchable(organizationId, now) {
      return withOrgContext(
        deps.db,
        { organizationId, userId: SYSTEM_USER_ID },
        async (tx): Promise<readonly WatchedFeed[]> => {
          // Active inbound feeds that are expected to be serving NOW: status active, inside the active window, not
          // revoked, and the feed-level BAA not past its expiry (the M40 gate's own refusals surface through the
          // supervisor's baa_* alerts). Same status / kind predicate the supervisor's feed loader binds.
          const res = await tx.execute(sql`
            SELECT f.id AS "feedId", f.organization_id AS "organizationId", f.port AS port,
                   GREATEST(COALESCE(f.approved_at, f.created_at), COALESCE(f.active_from, f.created_at)) AS "activatedAt",
                   f.listener_down_threshold_seconds AS "thresholdSeconds",
                   f.expected_quiet_windows AS "quietWindows",
                   s.listener_heartbeat_at AS "heartbeatAt", s.listener_bound AS "listenerBound",
                   s.circuit_state AS "circuitState", s.outage_opened_at AS "outageOpenedAt",
                   (SELECT max(m.received_at) FROM hl7_message_inbound m
                     WHERE m.organization_id = f.organization_id AND m.feed_id = f.id) AS "lastFrameAt"
              FROM external_feed f
              LEFT JOIN external_feed_listener_state s ON s.feed_id = f.id AND s.organization_id = f.organization_id
             WHERE f.organization_id = ${organizationId}::uuid
               AND f.status = 'active'
               AND f.kind IN ('adt_inbound', 'lab_inbound')
               AND f.revoked_at IS NULL
               AND (f.active_from IS NULL OR f.active_from <= ${now.toISOString()}::timestamptz)
               AND (f.active_through IS NULL OR f.active_through > ${now.toISOString()}::timestamptz)
               AND (f.baa_expires_on IS NULL OR f.baa_expires_on > ${now.toISOString()}::timestamptz)`);
          const rows = (res as unknown as { rows?: WatchRow[] }).rows ?? [];
          return rows.map((r) => ({
            feedId: r.feedId,
            organizationId: r.organizationId,
            port: Number(r.port),
            activatedAt: new Date(r.activatedAt),
            thresholdSeconds: r.thresholdSeconds === null ? null : Number(r.thresholdSeconds),
            expectedQuietWindows: r.quietWindows,
            heartbeatAt: asDate(r.heartbeatAt),
            listenerBound: r.listenerBound === true,
            circuitState: asState(r.circuitState),
            outageOpenedAt: asDate(r.outageOpenedAt),
            lastFrameAt: asDate(r.lastFrameAt),
          }));
        },
      );
    },

    async applyTransition(transition) {
      const { feed } = transition;
      await withOrgContext(
        deps.db,
        { organizationId: feed.organizationId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const db = tx as DbClient;
          // State: only the watcher-owned columns, so a concurrent listener heartbeat is never overwritten.
          await db
            .insert(STATE)
            .values({
              feedId: feed.feedId,
              organizationId: feed.organizationId,
              circuitState: transition.state,
              outageOpenedAt: transition.outageOpenedAt,
              lastEvaluatedAt: transition.evaluatedAt,
            })
            .onConflictDoUpdate({
              target: STATE.feedId,
              set: {
                circuitState: transition.state,
                outageOpenedAt: transition.outageOpenedAt,
                lastEvaluatedAt: transition.evaluatedAt,
                updatedAt: transition.evaluatedAt,
              },
            });
          // The dashboard reads the latest hourly rollup's breaker state: keep it in step with the decision.
          await db
            .insert(HEALTH)
            .values({
              feedId: feed.feedId,
              hourBucket: hourBucketOf(transition.evaluatedAt),
              organizationId: feed.organizationId,
              listenerCircuitState: transition.state,
            })
            .onConflictDoUpdate({
              target: [HEALTH.feedId, HEALTH.hourBucket],
              set: { listenerCircuitState: transition.state },
            });
          if (transition.event !== null) {
            await deps.outbox.publish(db, {
              eventName: transition.event.name,
              payload: transition.event.payload,
              organizationId: feed.organizationId,
              aggregateKind: "external_feed",
              aggregateId: feed.feedId,
            });
          }
        },
      );
    },
  };
}
