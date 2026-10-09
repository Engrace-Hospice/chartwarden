// apps/backend/src/modules/29-external-interfaces/listener/health-watch.ts - GAP-043. The listener-down DECISION, made
// where it survives the listener process dying.
//
// WHY A SECOND PROCESS. The in-process health tick (health-sweep.ts) cannot detect its own death: if the listener is
// OOM-killed no tick runs, no row is written and nothing pages; and a bound-but-wedged listener reads HALF_OPEN forever.
// The listener now only leaves FACTS behind (`external_feed_listener_state.listener_heartbeat_at` / `listener_bound`, every
// 30s). This watcher - a once-a-minute BullMQ job in the worker role - makes the DECISION from three independent facts:
//   1. heartbeat age (stale = older than HEARTBEAT_STALE_MS, three missed ticks, or never written),
//   2. an active TCP connect probe of the listener port (listener/tcp-probe.ts; no TLS probe - we hold no client cert),
//   3. the newest inbound frame (the existing signal).
// They feed the SAME pure transition table (`evaluateListenerCircuit`, circuit-breaker.ts), so its tested semantics carry
// over unchanged: probe = { tcpOk: connect && heartbeat fresh, tlsOk: heartbeat fresh && bound }.
//
// STATE AND EVENT ARE ONE TRANSACTION. A transition writes `external_feed_listener_state` and publishes the
// `m29.external_feed.listener_down` / `listener_recovered` outbox event together (store.applyTransition), so they cannot
// diverge, and a watcher that crashes re-evaluates from the stored state. M36's `feed-health-alerts` consumer turns the event
// into the page; this module never calls the AlertEmitter.
//
// EVENT RULES (on top of the transition table). `down` is published once per OUTAGE: only when no outage is open
// (`outageOpenedAt === null`), so an open -> half_open -> open flap does not re-page. `recovered` is published only when the
// breaker CLOSES an outage that was paged - a quiet partner that went closed -> half_open -> closed never announces a
// recovery from an outage nobody was told about.
//
// A feed with no heartbeat yet is given a grace period (twice its threshold from activation) before it can be called down.
import { type ListenerCircuitState, evaluateListenerCircuit } from "./circuit-breaker";
import { LISTENER_DOWN_THRESHOLD_FLOOR_MS } from "./circuit-breaker";
import { inStoredQuietWindow } from "./quiet-window";
import type { TcpProbe } from "./tcp-probe";

/** The listener ticks every 30s (LISTENER_RECONCILE_INTERVAL_MS); three missed ticks make the heartbeat stale. */
export const LISTENER_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 3 * LISTENER_HEARTBEAT_INTERVAL_MS;
/** Multiple of the feed's threshold a never-heartbeated feed is given after activation. */
const NEVER_STARTED_GRACE_FACTOR = 2;
const MS_PER_SECOND = 1000;

/** Everything the watcher knows about one watchable feed (the store joins feed + state + newest frame). */
export interface WatchedFeed {
  readonly feedId: string;
  readonly organizationId: string;
  readonly port: number;
  /** When the feed went live: the later of approval / `active_from` (falls back to creation). */
  readonly activatedAt: Date;
  /** `external_feed.listener_down_threshold_seconds` (60..300) or null = the 5 minute default. */
  readonly thresholdSeconds: number | null;
  /** `external_feed.expected_quiet_windows`, as stored. */
  readonly expectedQuietWindows: unknown;
  readonly heartbeatAt: Date | null;
  readonly listenerBound: boolean;
  readonly circuitState: ListenerCircuitState;
  readonly outageOpenedAt: Date | null;
  readonly lastFrameAt: Date | null;
}

export type WatchEventName =
  | "m29.external_feed.listener_down"
  | "m29.external_feed.listener_recovered";

export interface WatchEventPayload extends Record<string, unknown> {
  readonly feedId: string;
  readonly organizationId: string;
  readonly state: ListenerCircuitState;
  readonly silentSeconds: number | null;
  readonly lastFrameAt: string | null;
  readonly heartbeatStale: boolean;
  readonly tcpOk: boolean;
  readonly outageOpenedAt: string | null;
  readonly at: string;
}

export type FeedWatchDecision =
  /** Nothing to do: still inside the never-started grace period. */
  | { readonly kind: "grace" }
  /** Evaluated; `changed` is false when the stored state already says this. */
  | {
      readonly kind: "evaluated";
      readonly changed: boolean;
      readonly state: ListenerCircuitState;
      readonly outageOpenedAt: Date | null;
      readonly event: { readonly name: WatchEventName; readonly payload: WatchEventPayload } | null;
    };

const heartbeatIsFresh = (feed: WatchedFeed, nowMs: number): boolean =>
  feed.heartbeatAt !== null && nowMs - feed.heartbeatAt.getTime() <= HEARTBEAT_STALE_MS;

const thresholdMsOf = (feed: WatchedFeed): number =>
  feed.thresholdSeconds === null
    ? LISTENER_DOWN_THRESHOLD_FLOOR_MS
    : feed.thresholdSeconds * MS_PER_SECOND;

/** True when the probe is worth making: the feed is silent past its threshold and not in an expected quiet window. */
export function needsTcpProbe(feed: WatchedFeed, now: Date): boolean {
  const silent =
    feed.lastFrameAt === null || now.getTime() - feed.lastFrameAt.getTime() >= thresholdMsOf(feed);
  return silent && !inStoredQuietWindow(feed.expectedQuietWindows, now);
}

/**
 * PURE - the watcher's verdict for one feed. `tcpConnectOk` is the raw probe result (null = not probed, i.e. a frame is
 * recent or silence is expected, in which case the transition table does not read it).
 */
export function decideFeedWatch(
  feed: WatchedFeed,
  tcpConnectOk: boolean | null,
  now: Date,
): FeedWatchDecision {
  const nowMs = now.getTime();
  const thresholdMs = thresholdMsOf(feed);
  const heartbeatFresh = heartbeatIsFresh(feed, nowMs);

  if (feed.heartbeatAt === null) {
    const sinceActivation = nowMs - feed.activatedAt.getTime();
    if (sinceActivation < NEVER_STARTED_GRACE_FACTOR * thresholdMs) return { kind: "grace" };
  }

  const decision = evaluateListenerCircuit({
    current: feed.circuitState,
    lastFrameAtMs: feed.lastFrameAt === null ? null : feed.lastFrameAt.getTime(),
    probe: {
      tcpOk: (tcpConnectOk ?? false) && heartbeatFresh,
      tlsOk: heartbeatFresh && feed.listenerBound,
    },
    thresholdMs,
    inQuietWindow: inStoredQuietWindow(feed.expectedQuietWindows, now),
    nowMs,
  });

  const isNewOutage = decision.state === "open" && feed.outageOpenedAt === null;
  const closesPagedOutage = decision.state === "closed" && feed.outageOpenedAt !== null;
  const outageOpenedAt = isNewOutage
    ? now
    : decision.state === "closed"
      ? null
      : feed.outageOpenedAt;

  const eventName: WatchEventName | null = isNewOutage
    ? "m29.external_feed.listener_down"
    : closesPagedOutage
      ? "m29.external_feed.listener_recovered"
      : null;

  const payload: WatchEventPayload = {
    feedId: feed.feedId,
    organizationId: feed.organizationId,
    state: decision.state,
    silentSeconds:
      feed.lastFrameAt === null
        ? null
        : Math.max(0, Math.floor((nowMs - feed.lastFrameAt.getTime()) / MS_PER_SECOND)),
    lastFrameAt: feed.lastFrameAt === null ? null : feed.lastFrameAt.toISOString(),
    heartbeatStale: !heartbeatFresh,
    tcpOk: tcpConnectOk ?? false,
    // A recovery names the outage it closes; a down names the one it opens.
    outageOpenedAt: (isNewOutage ? now : feed.outageOpenedAt)?.toISOString() ?? null,
    at: now.toISOString(),
  };

  return {
    kind: "evaluated",
    changed: decision.state !== feed.circuitState || outageOpenedAt !== feed.outageOpenedAt,
    state: decision.state,
    outageOpenedAt,
    event: eventName === null ? null : { name: eventName, payload },
  };
}

/** What the store persists atomically for one transition. */
export interface WatchTransition {
  readonly feed: WatchedFeed;
  readonly state: ListenerCircuitState;
  readonly outageOpenedAt: Date | null;
  readonly evaluatedAt: Date;
  readonly event: { readonly name: WatchEventName; readonly payload: WatchEventPayload } | null;
}

export interface FeedWatchStore {
  /** The org's ACTIVE inbound feeds that are expected to be serving now (status, active window, BAA expiry). */
  listWatchable(organizationId: string, now: Date): Promise<readonly WatchedFeed[]>;
  /** Move the state row (+ the current hour's health row) and publish the event, in ONE transaction. */
  applyTransition(transition: WatchTransition): Promise<void>;
}

export interface FeedHealthWatchDeps {
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly store: FeedWatchStore;
  readonly probeTcp: TcpProbe;
  /** Where the listener's ports are reachable from the worker (deployment config). */
  readonly probeHost: string;
  readonly now: () => Date;
  readonly log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
}

export interface FeedHealthWatchSummary {
  readonly orgs: number;
  readonly evaluated: number;
  readonly wentDown: readonly string[];
  readonly recovered: readonly string[];
  readonly failed: readonly string[];
}

/** One watcher pass over every active org. A failing feed or org never stops the rest. */
export async function runFeedHealthWatch(
  deps: FeedHealthWatchDeps,
): Promise<FeedHealthWatchSummary> {
  const now = deps.now();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const wentDown: string[] = [];
  const recovered: string[] = [];
  const failed: string[] = [];
  let evaluated = 0;

  for (const { organizationId } of orgs) {
    let feeds: readonly WatchedFeed[];
    try {
      feeds = await deps.store.listWatchable(organizationId, now);
    } catch (err) {
      failed.push(`org:${organizationId}`);
      deps.log("warn", "hl7.listener.watch_org_failed", {
        organizationId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
      continue;
    }
    // Probes are independent network calls; run them together, then decide and persist feed by feed.
    const probes = await Promise.all(
      feeds.map((feed) =>
        needsTcpProbe(feed, now) ? deps.probeTcp(deps.probeHost, feed.port) : Promise.resolve(null),
      ),
    );
    for (const [index, feed] of feeds.entries()) {
      try {
        const decision = decideFeedWatch(feed, probes[index] ?? null, now);
        if (decision.kind === "grace") continue;
        evaluated += 1;
        if (!decision.changed) continue;
        await deps.store.applyTransition({
          feed,
          state: decision.state,
          outageOpenedAt: decision.outageOpenedAt,
          evaluatedAt: now,
          event: decision.event,
        });
        if (decision.event?.name === "m29.external_feed.listener_down") wentDown.push(feed.feedId);
        if (decision.event?.name === "m29.external_feed.listener_recovered") {
          recovered.push(feed.feedId);
        }
      } catch (err) {
        failed.push(feed.feedId);
        deps.log("warn", "hl7.listener.watch_feed_failed", {
          feedId: feed.feedId,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
  return { orgs: orgs.length, evaluated, wentDown, recovered, failed };
}
