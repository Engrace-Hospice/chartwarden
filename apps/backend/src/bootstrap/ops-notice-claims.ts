// apps/backend/src/bootstrap/ops-notice-claims.ts - ADR-0079 (G-4): a fleet-wide "notify once per window" claim for ops notices.
// The M36 ack-queue notices used a per-process Map, so with several workers (or after a restart) the same breach notified again at once.
// A claim is `SET key NX PX ttl` on the platform Valkey: the first process to ask wins, everyone else sees `false` until the key expires
// or is released (a recovery releases it so the next breach notifies at once). Fail-OPEN: when Valkey errors or is absent the claim falls
// back to a process-local map, i.e. exactly the previous behaviour - a duplicate notice is better than a silent breach.
export interface OpsNoticeClaims {
  /** True when this caller should notify now (it holds the claim for `ttlMs`). */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** The breach is over: let the next one notify at once. */
  release(key: string): Promise<void>;
}

/** The slice of ioredis the claims use (so tests pass a fake). */
export interface ClaimRedis {
  set(key: string, value: string, mode: "PX", ttlMs: number, flag: "NX"): Promise<"OK" | null>;
  del(key: string): Promise<unknown>;
}

const KEY_PREFIX = "wardenx:ops-notice:";

export function createOpsNoticeClaims(
  redis: ClaimRedis | undefined,
  now: () => number = Date.now,
): OpsNoticeClaims {
  const local = new Map<string, number>();
  const claimLocal = (key: string, ttlMs: number): boolean => {
    const previous = local.get(key);
    if (previous !== undefined && now() - previous < ttlMs) return false;
    local.set(key, now());
    return true;
  };
  return {
    async claim(key, ttlMs) {
      if (!redis) return claimLocal(key, ttlMs);
      try {
        return (await redis.set(`${KEY_PREFIX}${key}`, "1", "PX", ttlMs, "NX")) === "OK";
      } catch {
        return claimLocal(key, ttlMs);
      }
    },
    async release(key) {
      local.delete(key);
      if (!redis) return;
      try {
        await redis.del(`${KEY_PREFIX}${key}`);
      } catch {
        // The key expires on its own; a missed release only delays the next notice by at most its ttl.
      }
    },
  };
}
