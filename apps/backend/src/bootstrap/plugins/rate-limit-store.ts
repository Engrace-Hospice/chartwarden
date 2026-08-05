// apps/backend/src/bootstrap/plugins/rate-limit-store.ts — WX-PR-017: the cluster-wide counter
// store `applySecurityBaseline`'s limiter reads through. `security.ts`'s own FORWARD NOTE flagged
// this: an in-memory `Map` is correct for a single instance but each backend replica would run its
// own independent window, so a caller hammering the API could get `tiers.authenticatedPerMinute`
// requests through PER REPLICA rather than cluster-wide. `createInMemoryRateLimitStore` stays the
// default (tests and a single-instance dev boot need no Redis); `createRedisRateLimitStore` is what
// the composition root binds when `REDIS_URL` is set, over the SAME `queueConnection` ioredis client
// the M34 BullMQ queues and the `/ready` probe already share (apps/backend/src/index.ts).
import type Redis from "ioredis";

export interface RateLimitStore {
  /** Atomically increment `key`'s counter, arming its expiry to `windowMs` on the FIRST increment
   *  of a window (a fixed-window counter — the window resets when the key expires). Returns the
   *  count AFTER incrementing. */
  increment(key: string, windowMs: number): Promise<number>;
}

interface WindowCounter {
  count: number;
  windowStart: number;
}

/** Single-process default. Each replica has its own `Map`, so this under-counts across a cluster —
 *  correct only when there is exactly one backend instance (dev, tests, `rateLimitEnabled: false`
 *  callers aside). */
export function createInMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const counters = new Map<string, WindowCounter>();
  return {
    async increment(key, windowMs) {
      const t = now();
      const existing = counters.get(key);
      if (!existing || t - existing.windowStart >= windowMs) {
        counters.set(key, { count: 1, windowStart: t });
        return 1;
      }
      existing.count += 1;
      return existing.count;
    },
  };
}

// INCR then, ONLY on the first hit of a fresh key (current == 1), PEXPIRE it — a single round trip,
// atomic against a concurrent request racing the same key (the classic Redis fixed-window pattern;
// the alternative of separate INCR + EXPIRE calls has a window where a crash/delay between them
// leaves the key permanent).
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if tonumber(current) == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/** Cluster-wide store over the shared Valkey/Redis connection. Keys are namespaced under
 *  `ratelimit:` so they're visually distinguishable from BullMQ's own keys on the same instance
 *  (M34 queues and this limiter intentionally share one Valkey deployment, not one keyspace). */
export function createRedisRateLimitStore(redis: Redis): RateLimitStore {
  return {
    async increment(key, windowMs) {
      const result = await redis.eval(INCREMENT_SCRIPT, 1, `ratelimit:${key}`, windowMs);
      return typeof result === "number" ? result : Number(result);
    },
  };
}
