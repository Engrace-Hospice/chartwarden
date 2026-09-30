// apps/backend/src/modules/29-external-interfaces/outbound/rate-limiter.ts — a per-feed in-process
// throttle over `external_feed.rate_limit_msg_per_sec` (M29-T08, F-175/#248).
//
// A simple leaky-bucket-of-one: each feed remembers the instant its last dispatch attempt was ADMITTED,
// and the next admission waits out whatever is left of `1000 / ratePerSec` ms since then. This is a
// PER-PROCESS limiter (an in-memory Map, the brief's own "even a simple in-process token bucket keyed by
// feed id is fine" bar) — it does not coordinate across multiple backend replicas, so a horizontally-scaled
// deployment's aggregate outbound rate for one feed can exceed `rateLimitMsgPerSec` by a factor of the
// replica count. A cross-process limiter needs a shared clock (Redis `INCR`+`EXPIRE`, a Postgres advisory
// lock window) — real, separable follow-up work, not attempted here; single-process/dev/CI correctness is
// exact.
export interface FeedRateLimiter {
  /** Resolves once the caller may proceed with a send attempt for `feedId` at `ratePerSec`. */
  acquire(feedId: string, ratePerSec: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFeedRateLimiter(now: () => number = Date.now): FeedRateLimiter {
  const lastAdmittedAt = new Map<string, number>();
  return {
    async acquire(feedId, ratePerSec) {
      const rate = ratePerSec > 0 ? ratePerSec : 1;
      const minIntervalMs = 1000 / rate;
      for (;;) {
        const t = now();
        const last = lastAdmittedAt.get(feedId);
        const elapsed = last === undefined ? Number.POSITIVE_INFINITY : t - last;
        if (elapsed >= minIntervalMs) {
          lastAdmittedAt.set(feedId, t);
          return;
        }
        await sleep(Math.min(minIntervalMs - elapsed, 1000));
      }
    },
  };
}
