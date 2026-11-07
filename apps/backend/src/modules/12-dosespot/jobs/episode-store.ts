// apps/backend/src/modules/12-dosespot/jobs/episode-store.ts — the shared memory behind "alert once per episode" (review of slice 4, M3).
//
// One key per open episode in Valkey: `SET key 1 PX ttl NX` opens it (OK = this report opened it, nil = it was already open), `DEL`
// ends it (1 = it was open), and a report of an open episode only refreshes its lifetime. Every process sees the same keys, so:
//   - a restart or a second replica joins the open episode instead of alerting again;
//   - the process that SEES the recovery is the one that announces it, whichever process raised the alert (the in-memory tracker
//     could only announce a recovery for an alert it had raised itself, so the other replica's alerts stayed open forever).
// The lifetime is a backstop for an episode nobody reports any more (an org that went inactive mid-fault, a process that died between
// the SET and the publish): while a fault persists, every tick refreshes it, so it lapses only after it has gone unreported that long.
// ponytail: opening is SET-then-publish, not atomic with the publish. A publish that fails releases the key (see degradation-reports.ts),
// but if that DEL also fails the alert for that episode waits out the lifetime. Make it a single outbox-side claim if that ever matters.
import type { EpisodeTracker } from "./cron-common";

/** The subset of an ioredis client the tracker needs (so a test can stand in for it). */
export interface EpisodeStoreClient {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<"OK" | null>;
  pexpire(key: string, ms: number): Promise<number>;
  del(key: string): Promise<number>;
}

export const EPISODE_KEY_PREFIX = "chartwarden:m12:episode:";

/** An episode nobody has reported for this long is forgotten (a fault that persists is reported on every tick, refreshing it). */
export const EPISODE_TTL_MS = 24 * 60 * 60_000;

export function createValkeyEpisodeTracker(
  client: EpisodeStoreClient,
  options: { readonly ttlMs?: number } = {},
): EpisodeTracker {
  const ttlMs = options.ttlMs ?? EPISODE_TTL_MS;
  const keyOf = (key: string): string => `${EPISODE_KEY_PREFIX}${key}`;
  return {
    async raise(key) {
      if ((await client.set(keyOf(key), "1", "PX", ttlMs, "NX")) === "OK") return true;
      await client.pexpire(keyOf(key), ttlMs);
      return false;
    },
    async clear(key) {
      return (await client.del(keyOf(key))) > 0;
    },
  };
}
