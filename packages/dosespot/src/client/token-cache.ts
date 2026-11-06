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
