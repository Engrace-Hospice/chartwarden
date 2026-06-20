// @wardenx/messaging — the messaging cache port + an in-memory adapter (M36-T08, spec §4.8).
//
// The seam between the realtime/read paths and Valkey. Production binds a Valkey-backed adapter
// (string GET/SET with the §4.8 TTLs for the resolver cache; SADD/SMEMBERS/EXPIRE for the room-set;
// HINCRBY/HGETALL for the unread-count hash); the slice/tests bind the deterministic in-memory
// adapter below. The port stays small — string get/set, set add/read, hash incr/read/clear, prefix
// delete — so the same shape covers all three §4.8 caches (./keys builds the strings). No TTL
// eviction in-memory: tests assert hits/misses/invalidation explicitly, not expiry.

/** The §4.8 messaging cache: the three access patterns (string / set / hash) the caches need. */
export interface MessagingCache {
  // --- string cache (recipient-resolver results) ---
  /** Fetch a cached string value, or null on miss. */
  get(key: string): Promise<string | null>;
  /** Store a string under `key` with a TTL (seconds); the adapter honours TTL (in-memory ignores). */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Delete one key. */
  delete(key: string): Promise<void>;
  /** Delete every key with `prefix` — the en-masse invalidation (e.g. resolver cache on member edit). */
  deletePrefix(prefix: string): Promise<{ deleted: number }>;

  // --- set cache (per-user room membership, §4.3 connect) ---
  /** Replace the user's cached room set (`rooms:user:<id>`) with `rooms`, TTL = session length. */
  setRooms(key: string, rooms: readonly string[], ttlSeconds: number): Promise<void>;
  /** Read the user's cached room set (empty when absent / invalidated). */
  getRooms(key: string): Promise<string[]>;

  // --- hash cache (per-user unread counts, §4.8) ---
  /** Increment the unread count for `channelId` in the user's `unread:user:<id>` hash by `by`. */
  incrUnread(key: string, channelId: string, by: number): Promise<number>;
  /** Read the user's per-channel unread counts (PG `message_receipt` fallback when absent). */
  getUnread(key: string): Promise<Record<string, number>>;
  /** Drop one channel's unread entry (e.g. on read-all or channel archive). */
  clearUnread(key: string, channelId: string): Promise<void>;
}

/**
 * An in-memory {@link MessagingCache} for the slice + unit tests. Deterministic, no TTL eviction, no
 * I/O. `deletePrefix` linearly scans — fine for tests; the Valkey adapter uses SCAN+UNLINK. Unread
 * counts floor at 0 (a decrement never drives a badge negative — §4.8 PG-fallback semantics).
 */
export function createInMemoryMessagingCache(): {
  cache: MessagingCache;
  size(): number;
} {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, number>>();

  const cache: MessagingCache = {
    async get(key) {
      return strings.has(key) ? strings.get(key)! : null;
    },
    async set(key, value) {
      strings.set(key, value);
    },
    async delete(key) {
      strings.delete(key);
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      for (const key of [...strings.keys()]) {
        if (key.startsWith(prefix)) {
          strings.delete(key);
          deleted += 1;
        }
      }
      return { deleted };
    },
    async setRooms(key, rooms) {
      sets.set(key, new Set(rooms));
    },
    async getRooms(key) {
      return [...(sets.get(key) ?? [])];
    },
    async incrUnread(key, channelId, by) {
      const hash = hashes.get(key) ?? new Map<string, number>();
      const next = Math.max(0, (hash.get(channelId) ?? 0) + by);
      hash.set(channelId, next);
      hashes.set(key, hash);
      return next;
    },
    async getUnread(key) {
      return Object.fromEntries(hashes.get(key) ?? new Map());
    },
    async clearUnread(key, channelId) {
      hashes.get(key)?.delete(channelId);
    },
  };

  return { cache, size: () => strings.size + sets.size + hashes.size };
}
