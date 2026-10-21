// @chartwarden/terminology — the terminology cache port + an in-memory adapter (M38-T10, spec §4.6).
//
// The seam between the read path and Valkey. Production binds a Valkey-backed adapter (GET/SET with
// the §4.6 TTLs, MGET on the batch hot path, prefix DELETE on invalidation); the slice/tests bind
// the deterministic in-memory adapter below. The port is intentionally tiny — get / set / delete /
// deletePrefix — so the same shape covers all four caches (./keys builds the strings). No TTL
// eviction in-memory: tests assert hits/misses/invalidation explicitly, not expiry.

/** Cache the read path reads/writes; keyed on the ./keys grammar. Values are JSON-serialisable. */
export interface TerminologyCache {
  /** Fetch a cached value, or null on miss. */
  get(key: string): Promise<string | null>;
  /** Store a value under `key` with a TTL (seconds); the adapter honours TTL (in-memory ignores it). */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Delete one key (e.g. a tenant extension set on add/remove). */
  delete(key: string): Promise<void>;
  /** Delete every key with `prefix` — the en-masse invalidation a version load runs (§4.6). */
  deletePrefix(prefix: string): Promise<{ deleted: number }>;
}

/**
 * An in-memory {@link TerminologyCache} for the slice + unit tests. Deterministic, no TTL eviction,
 * no I/O. `deletePrefix` linearly scans — fine for tests; the Valkey adapter uses SCAN+UNLINK.
 */
export function createInMemoryTerminologyCache(): {
  cache: TerminologyCache;
  size(): number;
} {
  const map = new Map<string, string>();
  const cache: TerminologyCache = {
    async get(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
          deleted += 1;
        }
      }
      return { deleted };
    },
  };
  return { cache, size: () => map.size };
}
