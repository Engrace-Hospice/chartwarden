// @chartwarden/mdm — cache key grammar + TTLs + invalidation (M40-T10, spec §4.8).
//
// Pure, infra-free key construction for the two MDM caches. The keys + TTLs live here so the read
// path (resolve / resolve_batch) and the invalidation path (canonical update, overlay update) agree
// on EXACTLY one grammar — a mismatch would strand stale rows nobody can purge. The Valkey adapter
// (production) and the in-memory cache (slice/tests) both key on these strings; this module imports
// no client.
//
//   • resolved entity    mdm:<kind>:<id>:<orgId>                     TTL 5m  (§4.8)
//   • BAA status         baa:<method>:<orgId>:<entity>:<asOfBucket>  TTL 60s (§4.6.2 / §4.8)
//
// Invalidation:
//   • canonical update (NPPES sync / merge / promote) → drop EVERY org's key for the entity, via
//     the `mdm:<kind>:<id>:` PREFIX (cardinality bounded — one entity × N orgs).
//   • overlay update → drop the single `mdm:<kind>:<id>:<orgId>` key.

import type { MdmEntityKind } from "../interfaces/kinds";

/** Cache TTLs in seconds, per §4.8 (resolved entity 5m, BAA status 60s). */
export const MDM_CACHE_TTL_SECONDS = {
  resolvedEntity: 300,
  baaStatus: 60,
} as const;

/** `mdm:<kind>:<id>:<orgId>` — one tenant's resolved view of a canonical entity (§4.8). */
export function resolvedEntityKey(kind: MdmEntityKind, id: string, orgId: string): string {
  return `mdm:${kind}:${id}:${orgId}`;
}

/**
 * The PREFIX purged on a CANONICAL change (`mdm:<kind>:<id>:`) — drops every org's cached view of
 * the entity in one sweep (§4.8 `mdm.canonical_changed:<kind>:<id>`). Cardinality is bounded by the
 * number of tenants referencing the entity, so the broad delete is cheap.
 */
export function canonicalKeyPrefix(kind: MdmEntityKind, id: string): string {
  return `mdm:${kind}:${id}:`;
}

/** The pub/sub channel a canonical change publishes (§4.8). */
export function canonicalChangedChannel(kind: MdmEntityKind, id: string): string {
  return `mdm.canonical_changed:${kind}:${id}`;
}

/** The pub/sub channel an OVERLAY change publishes — a single-key delete (§4.8). */
export function overlayChangedChannel(kind: MdmEntityKind, id: string, orgId: string): string {
  return `mdm.overlay_changed:${kind}:${id}:${orgId}`;
}

/** Minute-granularity `asOf` bucket so a BAA-status key is stable within the 60s TTL (§4.6.2). */
export function asOfMinuteBucket(asOf: Date): string {
  // Truncate the ISO timestamp to the minute (`YYYY-MM-DDTHH:MM`) — no seconds, so retries inside a
  // minute share a key. Deterministic: derived from the passed-in Date, no clock read here.
  return asOf.toISOString().slice(0, 16);
}

/** `baa:<method>:<orgId>:<entity>:<asOfBucket>` — a cached BAA-status answer (§4.6.2 / §4.8). */
export function baaStatusKey(
  method: "by_sf" | "by_mdm",
  orgId: string,
  entity: string,
  asOf: Date,
): string {
  return `baa:${method}:${orgId}:${entity}:${asOfMinuteBucket(asOf)}`;
}
