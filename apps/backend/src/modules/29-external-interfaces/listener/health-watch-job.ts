// apps/backend/src/modules/29-external-interfaces/listener/health-watch-job.ts - GAP-043. The BullMQ plumbing for the
// worker-role listener-health watcher (health-watch.ts): one repeatable once-a-minute tick fanning out over the active
// orgs, the `registerM29OutboundRetrySweepWorker` shape. Constructed ONLY in a worker/all process and ONLY when
// `M29_LISTENER_WATCH_ENABLED=true` (see `resolveFeedHealthWatchConfig`): an environment with no listener process (dev,
// CI, preview) would otherwise page "down" for every active feed.
import { type ConnectionOptions, Queue, Worker } from "bullmq";

import { type FeedHealthWatchDeps, runFeedHealthWatch } from "./health-watch";

export const M29_FEED_HEALTH_WATCH_QUEUE = "m29.feed_health_watch";
/** Every minute (5-field, the repo's other crons' shape); a stale heartbeat is 90s, so one tick can see it. */
export const M29_FEED_HEALTH_WATCH_SCHEDULE = "* * * * *";

export type FeedHealthWatchConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly probeHost: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the watcher's switch from the environment. Off unless `M29_LISTENER_WATCH_ENABLED=true`; when on,
 * `M29_LISTENER_PROBE_HOST` (where the listener's ports are reachable from the worker) is REQUIRED - a missing host throws
 * at boot rather than starting a watcher that probes nothing, because the flag also tells the listener to stop paging.
 */
export function resolveFeedHealthWatchConfig(env: Env): FeedHealthWatchConfig {
  if (env.M29_LISTENER_WATCH_ENABLED !== "true") return { enabled: false };
  const probeHost = env.M29_LISTENER_PROBE_HOST?.trim();
  if (!probeHost) {
    throw new Error(
      "M29_LISTENER_WATCH_ENABLED=true requires M29_LISTENER_PROBE_HOST (the host the listener's feed ports are reachable on from the worker); refusing to boot a watcher that cannot probe, since the same flag stops the listener paging listener_down",
    );
  }
  return { enabled: true, probeHost };
}

export function registerM29FeedHealthWatchWorker(
  deps: FeedHealthWatchDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(M29_FEED_HEALTH_WATCH_QUEUE, () => runFeedHealthWatch(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

/** Register the repeatable schedule. Returns the Queue so the composition root can `close()` it. */
export async function scheduleM29FeedHealthWatchJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M29_FEED_HEALTH_WATCH_QUEUE, { connection });
  await queue.add(
    "tick",
    {},
    { repeat: { pattern: M29_FEED_HEALTH_WATCH_SCHEDULE, tz: "UTC" }, removeOnComplete: true },
  );
  return queue;
}
