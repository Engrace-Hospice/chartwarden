// apps/backend/src/bootstrap/ops-notice-claims.ts - ADR-0079 (G-4): a fleet-wide "notify once per window" claim for ops notices.
// The M36 ack-queue notices used a per-process Map, so with several workers (or after a restart) the same breach notified again at once.
// A claim is `SET key NX PX ttl` on the platform Valkey: the first process to ask wins, everyone else sees `false` until the key expires
// or is released (a recovery releases it so the next breach notifies at once). Fail-OPEN: when Valkey errors, is slow or absent the claim
// falls back to a process-local map, i.e. exactly the previous behaviour - a duplicate notice is better than a silent breach.
// A call to Valkey is bounded (CLAIM_TIMEOUT_MS), and after a failure or timeout a breaker sends every claim straight to the local map for
// BREAKER_MS, so a slow Valkey cannot stall the per-minute sweep or the watchdog for N rows x timeout.
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
export const CLAIM_TIMEOUT_MS = 200;
export const BREAKER_MS = 30_000;

export interface ClaimOptions {
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly breakerMs?: number;
}

export function createOpsNoticeClaims(
  redis: ClaimRedis | undefined,
  nowOrOptions: (() => number) | ClaimOptions = {},
): OpsNoticeClaims {
  const options: ClaimOptions =
    typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? CLAIM_TIMEOUT_MS;
  const breakerMs = options.breakerMs ?? BREAKER_MS;
  const local = new Map<string, number>(); // key -> expiry instant
  let brokenUntil = 0;

  const claimLocal = (key: string, ttlMs: number): boolean => {
    const t = now();
    for (const [k, expiry] of local) if (expiry <= t) local.delete(k); // prune: the map never outgrows the live claims
    if ((local.get(key) ?? 0) > t) return false;
    local.set(key, t + ttlMs);
    return true;
  };
  /** Runs a Valkey call with a deadline; any failure or timeout opens the breaker and returns undefined (use the local map). */
  const guarded = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    if (!redis || now() < brokenUntil) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("claim timeout")), timeoutMs);
        }),
      ]);
    } catch {
      brokenUntil = now() + breakerMs;
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async claim(key, ttlMs) {
      const result = await guarded(() =>
        (redis as ClaimRedis).set(`${KEY_PREFIX}${key}`, "1", "PX", ttlMs, "NX"),
      );
      return result === undefined ? claimLocal(key, ttlMs) : result === "OK";
    },
    async release(key) {
      local.delete(key);
      // A missed release only delays the next notice by at most its ttl.
      await guarded(() => (redis as ClaimRedis).del(`${KEY_PREFIX}${key}`));
    },
  };
}
