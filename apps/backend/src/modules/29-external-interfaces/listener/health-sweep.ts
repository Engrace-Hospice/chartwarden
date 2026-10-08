// apps/backend/src/modules/29-external-interfaces/listener/health-sweep.ts — GAP-043. The §4.11.1 step-4 health
// probe: every tick, for each ACTIVE inbound feed, advance the pure §4.11.5 circuit breaker
// (`evaluateListenerCircuit`) and persist the hourly `external_feed_health` rollup. Before this existed
// `evaluateListenerCircuit` had no caller and `external_feed_health` was never written, so a silent HL7 feed
// raised nothing and the feed-health dashboard always read zero.
//
// PROBE. The sweep runs in the listener process, which owns the registry: "the listener is serving" is
// `isBound(feedId)` (a stronger signal than a loopback TCP connect — the socket is OURS). A bound listener that
// is silent is HALF_OPEN (no alert: silence on a healthy listener is indistinguishable from a quiet partner);
// an UNBOUND listener that is silent for the threshold trips OPEN and dispatches the critical
// `external_feed.listener_down` M36 alert. Recovery (a frame within the window) closes the breaker.
//
// SCOPE NOTE. `external_feed` carries no `expectedQuietWindow` / per-feed threshold column yet, so the platform
// floor (5 min) applies to every feed and `inQuietWindow` is false; both are inputs here so a config column can
// feed them without touching the transition.
import {
  LISTENER_DOWN_THRESHOLD_FLOOR_MS,
  type ListenerCircuitState,
  evaluateListenerCircuit,
} from "./circuit-breaker";
import type { SupervisorAlert, SupervisorFeedDescriptor } from "./supervisor";

/** What the store knows about a feed before this tick. */
export interface FeedHealthSnapshot {
  /** The breaker state on the latest health row (`closed` when the feed has none yet). */
  readonly state: ListenerCircuitState;
  /** Epoch-ms of the newest inbound frame received on the feed, or null if none ever. */
  readonly lastFrameAtMs: number | null;
}

export interface FeedHealthRecord {
  readonly hourBucket: Date;
  readonly state: ListenerCircuitState;
  /** Seconds to ADD to the hour's `listener_up_seconds` / `listener_down_seconds`. */
  readonly upSecondsDelta: number;
  readonly downSecondsDelta: number;
}

export interface FeedHealthStorePort {
  snapshot(feed: SupervisorFeedDescriptor): Promise<FeedHealthSnapshot>;
  /** Upsert the (feed, hour) rollup row: add the deltas, set the state, refresh message counts. */
  record(feed: SupervisorFeedDescriptor, row: FeedHealthRecord): Promise<void>;
}

export interface FeedHealthTickDeps {
  readonly feeds: () => Promise<readonly SupervisorFeedDescriptor[]>;
  readonly isBound: (feedId: string) => boolean;
  readonly store: FeedHealthStorePort;
  readonly dispatchAlert: (alert: SupervisorAlert) => Promise<void>;
  readonly now: () => Date;
  readonly log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  readonly thresholdMs?: number;
}

export interface FeedHealthTickSummary {
  readonly evaluated: number;
  readonly wentDown: readonly string[];
  readonly recovered: readonly string[];
  readonly failed: readonly string[];
}

const HOUR_MS = 3_600_000;

/** The start of the UTC hour containing `at` (the `hour_bucket` key). */
export function hourBucketOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * One health tick. `elapsedSeconds` is the wall time since the previous tick (0 on the first), credited to
 * "up" unless the breaker is OPEN after this tick. A failure on one feed never stops the others.
 */
export async function runFeedHealthTick(
  deps: FeedHealthTickDeps,
  elapsedSeconds: number,
): Promise<FeedHealthTickSummary> {
  const now = deps.now();
  const nowMs = now.getTime();
  const wentDown: string[] = [];
  const recovered: string[] = [];
  const failed: string[] = [];
  const feeds = await deps.feeds();

  for (const feed of feeds) {
    try {
      const before = await deps.store.snapshot(feed);
      const serving = deps.isBound(feed.id);
      const decision = evaluateListenerCircuit({
        current: before.state,
        lastFrameAtMs: before.lastFrameAtMs,
        probe: { tcpOk: serving, tlsOk: serving },
        thresholdMs: deps.thresholdMs ?? LISTENER_DOWN_THRESHOLD_FLOOR_MS,
        inQuietWindow: false,
        nowMs,
      });
      const isOpen = decision.state === "open";
      await deps.store.record(feed, {
        hourBucket: hourBucketOf(now),
        state: decision.state,
        upSecondsDelta: isOpen ? 0 : elapsedSeconds,
        downSecondsDelta: isOpen ? elapsedSeconds : 0,
      });
      if (decision.emit === "m29.external_feed.listener_down") {
        wentDown.push(feed.id);
        await deps.dispatchAlert({
          kind: "external_feed.listener_down",
          severity: "critical",
          channel: "operator_on_call",
          feedId: feed.id,
          organizationId: feed.organizationId,
          title: `Inbound HL7 feed ${feed.displayName} is down`,
          body: `Feed ${feed.id} on org ${feed.organizationId} has received no frame for the listener-down threshold and its listener is not serving. No inbound HL7 is being accepted on this feed.`,
        });
      } else if (decision.emit === "m29.external_feed.listener_recovered") {
        recovered.push(feed.id);
        deps.log("info", "hl7.listener.recovered", { feedId: feed.id });
      }
    } catch (err) {
      failed.push(feed.id);
      deps.log("warn", "hl7.listener.health_tick_failed", {
        feedId: feed.id,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return { evaluated: feeds.length, wentDown, recovered, failed };
}
