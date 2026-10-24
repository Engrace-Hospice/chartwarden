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

/**
 * AC-05 — a BUDGETED limiter over a {@link RateLimitStore}, for the per-route budgets that are
 * far tighter than the global SD-055 per-minute tiers (M34 §22.1's 5/IP/hour on public signup being
 * the first). Structurally satisfies M34's own `RateLimiter` port — the composition root wires the
 * two together, so neither module imports the other.
 *
 * `retryAfterSeconds` is the window length, an honest UPPER bound: this is a fixed-window counter
 * and the store does not expose the key's remaining TTL, so the true wait is always ≤ what we
 * report. The same choice `security.ts` makes for the global tier.
 *
 * Fails OPEN on a store outage, matching `applySecurityBaseline`: rate limiting is a
 * defense-in-depth AVAILABILITY control, not an authorization gate, and a Valkey blip must not
 * take down the surface it protects. The caller logs it.
 */
export function createBudgetedRateLimiter(
  store: RateLimitStore,
  opts: {
    limit: number;
    windowMs: number;
    keyPrefix: string;
    onStoreError?: (err: unknown) => void;
    /** Opt-in: deny (with `storeError: true`) instead of allowing when the store throws. For routes where the budget IS
     *  the abuse control (an unauthenticated route that sends email), so an outage must not remove it. */
    failClosed?: boolean;
  },
): { consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number; storeError?: true }> } {
  return {
    async consume(key) {
      let count: number;
      try {
        count = await store.increment(`${opts.keyPrefix}:${key}`, opts.windowMs);
      } catch (err) {
        opts.onStoreError?.(err);
        return opts.failClosed ? { allowed: false, storeError: true } : { allowed: true };
      }
      if (count <= opts.limit) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.ceil(opts.windowMs / 1000) };
    },
  };
}

/**
 * AC-05 — the cluster-wide {@link FailedLoginStore} M2's §5.3.1 credential throttle reads through.
 * Same fixed-window INCR/PEXPIRE primitive as the limiter above, plus the READ (`failureCount`) the
 * guard needs to refuse BEFORE a credential is checked, and the DEL that clears a username's budget
 * on a successful sign-in. Keys are already hashed by the caller — no address reaches Valkey.
 *
 * Structurally satisfies `@chartwarden/auth`'s `FailedLoginStore`; the composition root wires the two,
 * so M1's plugin layer takes no dependency on M2's package.
 */
export function createRedisFailedLoginStore(redis: Redis): {
  recordFailure(key: string, windowMs: number): Promise<number>;
  failureCount(key: string): Promise<number>;
  clear(key: string): Promise<void>;
  remainingMs(key: string): Promise<number | null>;
} {
  const k = (key: string) => `ratelimit:${key}`;
  return {
    async recordFailure(key, windowMs) {
      const result = await redis.eval(INCREMENT_SCRIPT, 1, k(key), windowMs);
      return typeof result === "number" ? result : Number(result);
    },
    async failureCount(key) {
      const raw = await redis.get(k(key));
      const n = raw === null ? 0 : Number(raw);
      return Number.isFinite(n) ? n : 0;
    },
    async clear(key) {
      await redis.del(k(key));
    },
    async remainingMs(key) {
      const ttl = Number(await redis.pttl(k(key)));
      return ttl > 0 ? ttl : null; // -2 no key, -1 no expiry
    },
  };
}

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
