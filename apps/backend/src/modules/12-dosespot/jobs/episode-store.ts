// apps/backend/src/modules/12-dosespot/jobs/episode-store.ts — the shared memory behind "alert once per episode" (review of slice 4, M3).
//
// The memory is a few Valkey keys per episode (`<prefix><kind>:<episode key>`), shared by every process, so a restart or a second
// replica joins an open episode instead of alerting again, and the process that SEES the recovery announces it whichever process raised
// the alert. What makes it safe against a crash is that the long-lived state is only written AFTER the event it stands for has been
// committed, and every claim in between is short-lived and expires on its own:
//
//   open:<key>     the episode is open: its alert was published. Long lifetime, refreshed by every report of the fault.
//   pending:<key>  a process has claimed the right to publish the alert (SET NX, short lifetime). It is NOT refreshed by other reports, so a
//                  claimant that crashes, or whose publish fails and whose release fails too, frees the claim within the claim window and
//                  the next tick publishes: the alert is late, never lost. `confirmRaised` writes `open` once the publish has committed.
//   clean:<key>    consecutive clean ticks seen while the episode is open. A recovery is only announced after `cleanTicks` of them, and a
//                  report of the fault resets the count, so replicas that see the fault asymmetrically do not flap alert/recovery.
//   closing:<key>  the claim to publish the recovery (SET NX, short lifetime), symmetric to `pending`. A claimant that crashes leaves
//                  `open` in place; the claim expires and the next clean tick announces the recovery. `confirmCleared` removes the episode
//                  once the recovery has committed.
//
// At-least-once, not exactly-once: a process that dies AFTER its publish committed but BEFORE the confirm leaves the claim to expire and
// the event is published again (a second alert, or a second recovery notice). That is the price of never dropping one.

/**
 * Remembers which faults are already reported, so one is alerted ONCE per episode (and its clearing once) instead of on every tick, and
 * so neither the alert nor the recovery is dropped by a crash. Each announcement is a CLAIM that is confirmed after the event commits:
 *   `raise`         true = the caller owns announcing the alert: publish it, then `confirmRaised` (or `abortRaise` if the publish failed).
 *                   false = the episode is open (this report only keeps it so) or another process is announcing it right now.
 *   `clear`         true = the episode is open, has been clean for enough consecutive ticks, and the caller owns announcing the recovery:
 *                   publish it, then `confirmCleared` (or `abortClear`). false otherwise (not open, not clean long enough, or claimed).
 * Every method rejects when the memory cannot be reached: the caller must not read that as "no episode". Production uses the
 * Valkey-backed tracker (`episode-store.ts`), shared by every process; the in-memory one is for one process (tests, a boot without Valkey).
 */
export interface EpisodeTracker {
  raise(key: string): Promise<boolean>;
  confirmRaised(key: string): Promise<void>;
  abortRaise(key: string): Promise<void>;
  clear(key: string): Promise<boolean>;
  confirmCleared(key: string): Promise<void>;
  abortClear(key: string): Promise<void>;
}

/** The subset of an ioredis client the tracker needs (so a test can stand in for it). */
export interface EpisodeStoreClient {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<"OK" | null>;
  set(key: string, value: string, px: "PX", ms: number): Promise<"OK" | null>;
  pexpire(key: string, ms: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  incr(key: string): Promise<number>;
}

export const EPISODE_KEY_PREFIX = "chartwarden:m12:episode:";

/** An open episode nobody has reported for this long is forgotten (a fault that persists is reported on every tick, refreshing it). */
export const EPISODE_TTL_MS = 24 * 60 * 60_000;
/** How long a claim to publish (the alert or the recovery) holds before another process may take it over. */
export const EPISODE_CLAIM_MS = 2 * 60_000;
/** Consecutive clean ticks required before a recovery is announced. */
export const EPISODE_CLEAN_TICKS = 2;

export interface EpisodeTrackerOptions {
  readonly ttlMs?: number;
  readonly claimMs?: number;
  readonly cleanTicks?: number;
}

export function createValkeyEpisodeTracker(
  client: EpisodeStoreClient,
  options: EpisodeTrackerOptions = {},
): EpisodeTracker {
  const ttlMs = options.ttlMs ?? EPISODE_TTL_MS;
  const claimMs = options.claimMs ?? EPISODE_CLAIM_MS;
  const cleanTicks = options.cleanTicks ?? EPISODE_CLEAN_TICKS;
  const at = (part: "open" | "pending" | "clean" | "closing", key: string): string =>
    `${EPISODE_KEY_PREFIX}${part}:${key}`;
  return {
    async raise(key) {
      // an open episode: keep it open and restart the clean-tick count
      if ((await client.pexpire(at("open", key), ttlMs)) === 1) {
        await client.del(at("clean", key));
        return false;
      }
      // not open: claim the right to publish. A claim already held (by this or another process) is NOT refreshed.
      return (await client.set(at("pending", key), "1", "PX", claimMs, "NX")) === "OK";
    },
    async confirmRaised(key) {
      await client.set(at("open", key), "1", "PX", ttlMs);
      await client.del(at("pending", key), at("clean", key));
    },
    async abortRaise(key) {
      await client.del(at("pending", key));
    },
    async clear(key) {
      if ((await client.exists(at("open", key))) !== 1) return false; // the healthy common path: one read
      const clean = await client.incr(at("clean", key));
      if (clean === 1) await client.pexpire(at("clean", key), ttlMs);
      if (clean < cleanTicks) return false;
      return (await client.set(at("closing", key), "1", "PX", claimMs, "NX")) === "OK";
    },
    async confirmCleared(key) {
      await client.del(at("open", key), at("closing", key), at("clean", key));
    },
    async abortClear(key) {
      await client.del(at("closing", key));
    },
  };
}

/**
 * A single-process stand-in for Valkey with the same expiry semantics (tests, and a boot with no Valkey). `now` is injectable so a test
 * can move time without sleeping.
 */
export function createInMemoryEpisodeStore(now: () => number = Date.now): EpisodeStoreClient {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string): { value: string; expiresAt: number | null } | undefined => {
    const entry = values.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async set(key: string, value: string, _px: "PX", ms: number, nx?: "NX") {
      if (nx === "NX" && live(key) !== undefined) return null;
      values.set(key, { value, expiresAt: now() + ms });
      return "OK";
    },
    async pexpire(key, ms) {
      const entry = live(key);
      if (entry === undefined) return 0;
      values.set(key, { ...entry, expiresAt: now() + ms });
      return 1;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (live(key) !== undefined) removed += 1;
        values.delete(key);
      }
      return removed;
    },
    async exists(key) {
      return live(key) === undefined ? 0 : 1;
    },
    async incr(key) {
      const entry = live(key);
      const next = Number(entry?.value ?? "0") + 1;
      values.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
  };
}
