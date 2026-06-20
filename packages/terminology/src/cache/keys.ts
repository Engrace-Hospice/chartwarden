// @wardenx/terminology — cache key grammar + TTLs + invalidation (M38-T10, spec §4.6).
//
// Pure, infra-free key construction for the four terminology caches. The keys + TTLs live here so
// the read path (lookup/expand/isMemberOf/search) and the invalidation path (version load, member
// edit, extension add/remove) agree on EXACTLY one grammar — a mismatch would leave stale rows
// nobody can purge. The Valkey adapter (production) and the in-memory cache (slice/tests, ./store)
// both key on these strings; this module imports no client.
//
//   • concept lookup       term:lookup:<system>:<code>:<asOf>            TTL 1h   (§4.6)
//   • value-set membership  term:vs:<id>:<system>:<code>:<asOf>           TTL 1h
//   • search results        term:search:<system>:<mode>:<hash>:<asOf>     TTL 15m  (best-effort)
//   • tenant extension      term:vsext:<orgId>:<valueSetId>               TTL 5m
//
// Invalidation is by PREFIX: a version load for a system drops `term:lookup:<system>:` and
// `term:vs:` rows that include it; an extension add/remove drops `term:vsext:<orgId>:<valueSetId>`.

import type { CodeSystemId } from "../interfaces/kinds";

/** Cache TTLs in seconds, per §4.6 (lookup/membership 1h, search 15m, tenant extension 5m). */
export const TERMINOLOGY_CACHE_TTL_SECONDS = {
  lookup: 3600,
  valueSet: 3600,
  search: 900,
  tenantExtension: 300,
} as const;

/** The `asOf` ISO date a cache key embeds; lookups without one cache under today (the read path normalizes). */
function asOfSegment(asOfIso: string): string {
  return asOfIso;
}

/** `term:lookup:<system>:<code>:<asOf>` — a single concept resolution (§4.6). */
export function lookupKey(system: CodeSystemId, code: string, asOfIso: string): string {
  return `term:lookup:${system}:${code}:${asOfSegment(asOfIso)}`;
}

/** Prefix purged on a version load for `system` — every cached lookup of that system (§4.6). */
export function lookupSystemPrefix(system: CodeSystemId): string {
  return `term:lookup:${system}:`;
}

/** `term:vs:<id>:<system>:<code>:<asOf>` — a value-set membership answer (§4.6). */
export function valueSetMembershipKey(
  valueSetId: string,
  system: CodeSystemId,
  code: string,
  asOfIso: string,
): string {
  return `term:vs:${valueSetId}:${system}:${code}:${asOfSegment(asOfIso)}`;
}

/** Prefix purged on a value-set member edit / version load — every cached membership of a set (§4.6). */
export function valueSetPrefix(valueSetId: string): string {
  return `term:vs:${valueSetId}:`;
}

/** `term:search:<system>:<mode>:<hash(q,opts)>:<asOf>` — a search result page (§4.6, best-effort). */
export function searchKey(
  system: CodeSystemId,
  mode: string,
  queryOptsHash: string,
  asOfIso: string,
): string {
  return `term:search:${system}:${mode}:${queryOptsHash}:${asOfSegment(asOfIso)}`;
}

/** Prefix purged on a version load for `system` — every cached search over that system (§4.6). */
export function searchSystemPrefix(system: CodeSystemId): string {
  return `term:search:${system}:`;
}

/** `term:vsext:<orgId>:<valueSetId>` — a tenant's extension set for one value set (§4.6). */
export function tenantExtensionKey(orgId: string, valueSetId: string): string {
  return `term:vsext:${orgId}:${valueSetId}`;
}

/**
 * The cache prefixes a version load for `system` invalidates en masse (§4.6): every concept lookup,
 * every search, and — because a new version can change which codes a value set contains — the
 * membership caches. Value-set membership rows are keyed by set id, not system, so a loader purges
 * the membership caches of the affected sets explicitly via {@link valueSetPrefix}; this returns the
 * system-keyed prefixes a load always drops.
 */
export function versionLoadInvalidationPrefixes(system: CodeSystemId): readonly string[] {
  return [lookupSystemPrefix(system), searchSystemPrefix(system)];
}

/**
 * A stable, dependency-free hash of a search query + its options, for the search cache key. FNV-1a
 * over a canonical key=value rendering — deterministic across runs (no clock/RNG), collision-cheap
 * enough for a best-effort 15-minute cache. NOT a security hash.
 */
export function hashQueryOpts(q: string, opts: Readonly<Record<string, unknown>> = {}): string {
  const canonical =
    `q=${q}|` +
    Object.keys(opts)
      .sort()
      .map((k) => `${k}=${String(opts[k])}`)
      .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
