// @chartwarden/dosespot — token cache keys. A token belongs to ONE credential generation (the config's `version`; an env-served config is
// generation 0): a rotated key never reuses the old key's token, and minting for a new generation drops that clinician's tokens of every
// other generation, which can never be served again and are live bearer tokens sitting in memory.
export const tokenCacheKey = (
  orgId: string,
  clinicianId: string,
  version: number | undefined,
): string => `${orgId}|${clinicianId}|${version ?? 0}`;

/** Remove every cached token for (org, clinician) except `keepKey`'s generation. Returns how many were dropped. */
export function evictOtherGenerations(
  tokens: Map<string, unknown>,
  orgId: string,
  clinicianId: string,
  keepKey: string,
): number {
  const prefix = `${orgId}|${clinicianId}|`; // the trailing bar stops a clinician id that merely shares a prefix matching
  let dropped = 0;
  for (const key of [...tokens.keys()]) {
    if (key.startsWith(prefix) && key !== keepKey) {
      tokens.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** Drop every entry `isExpired` says is past its life. Returns how many were dropped. */
export function pruneExpired<V>(map: Map<string, V>, isExpired: (value: V) => boolean): number {
  let dropped = 0;
  for (const [key, value] of [...map.entries()]) {
    if (isExpired(value)) {
      map.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Keeps an in-memory credential cache from outliving its life in a process that no longer asks for it. A lookup prunes the map too, but a
 * tenant that left the active set (suspended, closed, its key ring shredded) is never looked up again, so its entry (an unsealed clinic
 * key, a live bearer token) would sit until the process exits. Call the returned `arm()` after adding an entry: while the map holds
 * anything an unref'd timer prunes it every minute, and it stops itself when the map is empty (nothing runs for a process that caches
 * nothing, and a test never leaks a timer).
 */
export function createExpirySweeper<V>(
  map: Map<string, V>,
  isExpired: (value: V) => boolean,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  return function arm(): void {
    if (timer !== null) return;
    const handle = setInterval(() => {
      pruneExpired(map, isExpired);
      if (map.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }, intervalMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    timer = handle;
  };
}
